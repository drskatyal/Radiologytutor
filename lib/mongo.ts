// ============================================================================
// lib/mongo.ts
//
// MongoDB connection + collection plumbing for the FlowRad Learn data layer.
//
// This file is the MongoDB half of the "STORE SEAM" documented in lib/cases.ts.
// It is deliberately self-contained: nothing here is imported unless a DB is
// actually configured (`MONGODB_URI` set). Connecting is LAZY — we never touch
// the network at import/build time, so `npm run build` and `npm test` work with
// no database (the JSON-on-volume store remains the default/fallback).
//
// Singleton connection: serverless platforms (and Next.js hot-reload in dev)
// re-evaluate modules frequently. To avoid a connection storm we cache the
// MongoClient (and its connect() promise) on `globalThis`, so every invocation
// in the same process reuses one pooled client.
// ============================================================================

import { MongoClient, type Db, type MongoClientOptions } from "mongodb";

// ---------------------------------------------------------------------------
// Config (read lazily; never required at import time)
// ---------------------------------------------------------------------------

const DEFAULT_DB_NAME = "flowrad";

/** True when a MongoDB connection string is configured in the environment. */
export function mongoConfigured(): boolean {
  return Boolean(process.env.MONGODB_URI && process.env.MONGODB_URI.trim());
}

function dbName(): string {
  return process.env.MONGODB_DB?.trim() || DEFAULT_DB_NAME;
}

// ---------------------------------------------------------------------------
// Cached client (singleton across hot-reload / serverless invocations)
// ---------------------------------------------------------------------------

interface MongoCache {
  client: MongoClient | null;
  /** In-flight (or resolved) connection promise; reused to avoid storms. */
  promise: Promise<MongoClient> | null;
}

// Stash the cache on globalThis so module re-evaluation reuses one client.
const globalForMongo = globalThis as unknown as { __flowradMongo?: MongoCache };

const cache: MongoCache =
  globalForMongo.__flowradMongo ??
  (globalForMongo.__flowradMongo = { client: null, promise: null });

const CLIENT_OPTIONS: MongoClientOptions = {
  // Keep the pool modest; serverless functions are short-lived and many.
  maxPoolSize: 10,
  // Fail fast with a clear error instead of hanging if the cluster is down.
  serverSelectionTimeoutMS: 10_000,
};

/**
 * Connect (once) and return the shared MongoClient. Subsequent calls reuse the
 * same in-flight/resolved promise. On failure we clear the cached promise so a
 * later call can retry, and we surface a clean error that never leaks the URI.
 */
async function getClient(): Promise<MongoClient> {
  if (cache.client) return cache.client;
  if (!cache.promise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      // Should never happen (callers gate on mongoConfigured()), but be safe.
      throw new Error("MongoDB is not configured (MONGODB_URI is unset).");
    }
    const client = new MongoClient(uri, CLIENT_OPTIONS);
    cache.promise = client
      .connect()
      .then((connected) => {
        cache.client = connected;
        return connected;
      })
      .catch((err) => {
        // Allow a retry on the next call, and never echo the connection string.
        cache.promise = null;
        throw new Error(
          `Failed to connect to MongoDB: ${
            err instanceof Error ? err.message : "unknown error"
          }`
        );
      });
  }
  return cache.promise;
}

/** Get the configured application database (lazily connecting on first use). */
export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(dbName());
}

// ---------------------------------------------------------------------------
// Indexes (created once per process, after first connect)
// ---------------------------------------------------------------------------

let indexesReady: Promise<void> | null = null;

/**
 * Ensure the indexes the data layer relies on exist. Called once per process
 * (idempotent — createIndex is a no-op if the index already exists). Tuned for
 * fast org-scoped list queries at 500+ cases (CLAUDE.md §4a performance note).
 */
export function ensureIndexes(): Promise<void> {
  if (!indexesReady) {
    indexesReady = (async () => {
      try {
        const db = await getDb();
        await Promise.all([
          // Cases: list-by-org, and list-by-org filtered by publication status.
          db.collection("cases").createIndex({ orgId: 1 }),
          db.collection("cases").createIndex({ orgId: 1, status: 1 }),
          // Patients: list-by-org.
          db.collection("patients").createIndex({ orgId: 1 }),
          // Studies: list-by-org, and a patient's studies within an org.
          db.collection("studies").createIndex({ orgId: 1 }),
          db.collection("studies").createIndex({ orgId: 1, patientId: 1 }),
        ]);
      } catch {
        // Indexes are an optimization; never block reads/writes if they fail.
        indexesReady = null;
      }
    })();
  }
  return indexesReady;
}
