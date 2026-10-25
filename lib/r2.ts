// ============================================================================
// lib/r2.ts  (server only)
//
// S3-compatible object storage for narration audio and cached DICOM frames.
// Default target is Cloudflare R2. Set R2_ENDPOINT to point the same client
// at another S3 API — on Cloud Run that is GCS HMAC
// (`https://storage.googleapis.com`) so the frame cache stays in-region.
//
// Env for writes:
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//   R2_ACCOUNT_ID   — required for the default R2 endpoint
//   R2_ENDPOINT     — optional full endpoint; when set, R2_ACCOUNT_ID is unused
// Optional:
//   R2_PUBLIC_BASE_URL  — public CDN / r2.dev origin for getObjectUrl()
//
// When unset, r2Configured() is false and put/get/sign no-op so `npm run build`
// and local JSON-on-volume still work. Callers (lib/audioStore) fall back to
// DATA_DIR. Never import this from a client component.
// Frame bytes stay private: leave R2_PUBLIC_BASE_URL unset for the DICOM cache.
// ============================================================================

export interface ObjectStoreEnv {
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  endpoint?: string;
}

/** Resolved bucket + endpoint, or null when the store is not configured. */
export function resolveObjectStore(
  env: ObjectStoreEnv
): { endpoint: string; bucket: string } | null {
  const access = env.accessKeyId?.trim();
  const secret = env.secretAccessKey?.trim();
  const bucketName = env.bucket?.trim();
  if (!access || !secret || !bucketName) return null;
  const override = env.endpoint?.trim().replace(/\/+$/, "");
  if (override) return { endpoint: override, bucket: bucketName };
  const account = env.accountId?.trim();
  if (!account) return null;
  return { endpoint: `https://${account}.r2.cloudflarestorage.com`, bucket: bucketName };
}

function objectStoreEnv(): ObjectStoreEnv {
  return {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
    endpoint: process.env.R2_ENDPOINT,
  };
}

export function r2Configured(): boolean {
  return resolveObjectStore(objectStoreEnv()) != null;
}

function bucket(): string {
  return resolveObjectStore(objectStoreEnv())!.bucket;
}

function endpoint(): string {
  return resolveObjectStore(objectStoreEnv())!.endpoint;
}

function publicBase(): string | null {
  const b = process.env.R2_PUBLIC_BASE_URL?.trim();
  return b ? b.replace(/\/+$/, "") : null;
}

function cleanKey(key: string): string {
  return key.replace(/^\/+/, "");
}

type S3ClientLike = {
  send: (command: unknown) => Promise<unknown>;
};

let cachedClient: S3ClientLike | null = null;

/**
 * Lazy S3 client. Dynamic import keeps webpack from exploding at build when
 * R2 is unused. `requestChecksumCalculation: WHEN_REQUIRED` is required —
 * AWS SDK v3 ≥3.729 sends checksum headers R2 otherwise rejects.
 */
async function getClient(): Promise<S3ClientLike | null> {
  if (!r2Configured()) return null;
  if (cachedClient) return cachedClient;
  try {
    const { S3Client } = await import("@aws-sdk/client-s3");
    cachedClient = new S3Client({
      region: "auto",
      endpoint: endpoint(),
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!.trim(),
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!.trim(),
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }) as unknown as S3ClientLike;
    return cachedClient;
  } catch {
    return null;
  }
}

export interface PutObjectResult {
  key: string;
  url: string | null;
}

/**
 * Put bytes into R2. No-ops (returns null) when R2 is unset or the SDK cannot
 * load, so callers can fall back to local disk.
 */
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string
): Promise<PutObjectResult | null> {
  const client = await getClient();
  if (!client) return null;
  const Key = cleanKey(key);
  try {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await client.send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key,
        Body: body,
        ContentType: contentType,
      })
    );
    return { key: Key, url: getObjectUrl(Key) };
  } catch (e) {
    throw new Error(`R2 put failed: ${e instanceof Error ? e.message : "unknown error"}`);
  }
}

/** Public object URL when R2_PUBLIC_BASE_URL is set; otherwise null (use signed GET). */
export function getObjectUrl(key: string): string | null {
  const base = publicBase();
  if (!base) return null;
  return `${base}/${cleanKey(key)}`;
}

export interface GetObjectResult {
  bytes: Buffer;
  contentType: string;
}

/** Read an object. Null when unset, missing, or the SDK cannot load. */
export async function getObject(key: string): Promise<GetObjectResult | null> {
  const client = await getClient();
  if (!client) return null;
  try {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const out = (await client.send(
      new GetObjectCommand({ Bucket: bucket(), Key: cleanKey(key) })
    )) as { Body?: { transformToByteArray: () => Promise<Uint8Array> }; ContentType?: string };
    if (!out.Body) return null;
    const bytes = Buffer.from(await out.Body.transformToByteArray());
    return { bytes, contentType: out.ContentType || "application/octet-stream" };
  } catch {
    return null;
  }
}

/**
 * Time-limited GET URL for a private object. Null when R2 is unset.
 * Default expiry: 1 hour.
 */
export async function getSignedGetUrl(
  key: string,
  expiresInSeconds = 3600
): Promise<string | null> {
  const client = await getClient();
  if (!client) return null;
  try {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const command = new GetObjectCommand({ Bucket: bucket(), Key: cleanKey(key) });
    return await getSignedUrl(
      client as Parameters<typeof getSignedUrl>[0],
      command,
      { expiresIn: expiresInSeconds }
    );
  } catch {
    return null;
  }
}

// Aliases for older call sites / docs that used an r2* prefix.
export const r2PutObject = putObject;
export const r2GetObject = getObject;
export const r2ObjectUrl = getObjectUrl;
