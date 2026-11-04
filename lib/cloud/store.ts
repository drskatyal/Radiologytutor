// STORE SEAM for FlowRad Viewer accounts, studies, collections and shares.
//
// One interface, two backends:
//   • Firestore (FIRESTORE_PROJECT set): production on Cloud Run, through the
//     REST client in ./firestore (metadata-server token, no SDK).
//   • Memory, optionally persisted to a JSON file (VIEWER_STORE_FILE): local
//     development and tests. Refused on Cloud Run, where it would lose data on
//     every instance restart.
//
// Callers never know which one they have. Every read that takes an owner id
// is the authorization boundary: route handlers pass the SESSION's user id,
// never one from the request.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FirestoreClient, firestoreConfig } from "./firestore";
import type { Account, Collection, CollectionPatch, Share, Study, StudyPatch } from "./types";
import type { DeviceLink } from "./entitlements";

export interface ViewerStore {
  readonly kind: "firestore" | "memory";
  getAccount(id: string): Promise<Account | null>;
  putAccount(account: Account): Promise<void>;
  patchAccount(id: string, patch: Partial<Pick<Account, "plan" | "name" | "bindings">>): Promise<void>;

  listStudies(ownerId: string): Promise<Study[]>;
  getStudy(id: string): Promise<Study | null>;
  createStudy(study: Study): Promise<void>;
  patchStudy(id: string, patch: StudyPatch | Partial<Study>): Promise<void>;
  deleteStudy(id: string): Promise<void>;

  listCollections(ownerId: string): Promise<Collection[]>;
  getCollection(id: string): Promise<Collection | null>;
  createCollection(c: Collection): Promise<void>;
  patchCollection(id: string, patch: CollectionPatch): Promise<void>;
  deleteCollection(id: string): Promise<void>;

  listShares(ownerId: string): Promise<Share[]>;
  getShare(token: string): Promise<Share | null>;
  createShare(share: Share): Promise<void>;
  patchShare(token: string, patch: Partial<Pick<Share, "revokedAt" | "expiresAt" | "allowDownload">>): Promise<void>;

  /** Desktop sign-in links (lib/cloud/entitlements.ts), keyed by pollId. */
  createDeviceLink(link: DeviceLink): Promise<void>;
  getDeviceLink(pollId: string): Promise<DeviceLink | null>;
  findDeviceLinkByCode(userCode: string): Promise<DeviceLink | null>;
  patchDeviceLink(pollId: string, patch: Partial<Pick<DeviceLink, "status" | "userId">>): Promise<void>;
}

/** Short random id for studies and collections (URL-safe). */
export function newId(): string {
  return randomBytes(12).toString("base64url");
}

const byNewest = <T extends { createdAt: string }>(a: T, b: T) => b.createdAt.localeCompare(a.createdAt);

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------

const COL = {
  accounts: "viewer_accounts",
  studies: "viewer_studies",
  collections: "viewer_collections",
  shares: "viewer_shares",
  deviceLinks: "viewer_device_links",
} as const;

class FirestoreStore implements ViewerStore {
  readonly kind = "firestore" as const;
  constructor(private readonly fs: FirestoreClient) {}
  getAccount(id: string) {
    return this.fs.get<Account>(COL.accounts, id);
  }
  putAccount(a: Account) {
    return this.fs.set(COL.accounts, a.id, { ...a });
  }
  patchAccount(id: string, patch: Partial<Pick<Account, "plan" | "name" | "bindings">>) {
    return this.fs.patch(COL.accounts, id, patch);
  }
  async listStudies(ownerId: string) {
    return (await this.fs.whereEqual<Study>(COL.studies, "ownerId", ownerId)).sort(byNewest);
  }
  getStudy(id: string) {
    return this.fs.get<Study>(COL.studies, id);
  }
  createStudy(s: Study) {
    return this.fs.set(COL.studies, s.id, { ...s }, true);
  }
  patchStudy(id: string, patch: Partial<Study>) {
    return this.fs.patch(COL.studies, id, { ...patch, updatedAt: new Date().toISOString() });
  }
  deleteStudy(id: string) {
    return this.fs.delete(COL.studies, id);
  }
  async listCollections(ownerId: string) {
    return (await this.fs.whereEqual<Collection>(COL.collections, "ownerId", ownerId)).sort(byNewest);
  }
  getCollection(id: string) {
    return this.fs.get<Collection>(COL.collections, id);
  }
  createCollection(c: Collection) {
    return this.fs.set(COL.collections, c.id, { ...c }, true);
  }
  patchCollection(id: string, patch: CollectionPatch) {
    return this.fs.patch(COL.collections, id, { ...patch, updatedAt: new Date().toISOString() });
  }
  deleteCollection(id: string) {
    return this.fs.delete(COL.collections, id);
  }
  async listShares(ownerId: string) {
    return (await this.fs.whereEqual<Share>(COL.shares, "ownerId", ownerId)).sort(byNewest);
  }
  getShare(token: string) {
    return this.fs.get<Share>(COL.shares, token);
  }
  createShare(s: Share) {
    return this.fs.set(COL.shares, s.token, { ...s }, true);
  }
  patchShare(token: string, patch: Partial<Share>) {
    return this.fs.patch(COL.shares, token, patch);
  }
  createDeviceLink(link: DeviceLink) {
    return this.fs.set(COL.deviceLinks, link.pollId, { ...link }, true);
  }
  getDeviceLink(pollId: string) {
    return this.fs.get<DeviceLink>(COL.deviceLinks, pollId);
  }
  async findDeviceLinkByCode(userCode: string) {
    const rows = await this.fs.whereEqual<DeviceLink>(COL.deviceLinks, "userCode", userCode, 5);
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }
  patchDeviceLink(pollId: string, patch: Partial<DeviceLink>) {
    return this.fs.patch(COL.deviceLinks, pollId, patch);
  }
}

// ---------------------------------------------------------------------------
// Memory (+ optional JSON file)
// ---------------------------------------------------------------------------

interface MemoryData {
  accounts: Record<string, Account>;
  studies: Record<string, Study>;
  collections: Record<string, Collection>;
  shares: Record<string, Share>;
  deviceLinks: Record<string, DeviceLink>;
}

const clone = <T>(v: T): T => (v == null ? v : (JSON.parse(JSON.stringify(v)) as T));

export class MemoryStore implements ViewerStore {
  readonly kind = "memory" as const;
  private data: MemoryData = { accounts: {}, studies: {}, collections: {}, shares: {}, deviceLinks: {} };
  constructor(private readonly file: string | null = null) {
    if (file && existsSync(file)) {
      try {
        this.data = { ...this.data, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<MemoryData>) };
        this.data.deviceLinks ??= {};
      } catch {
        // A corrupt dev file starts empty rather than crashing the server.
      }
    }
  }
  private save() {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  async getAccount(id: string) {
    return clone(this.data.accounts[id] ?? null);
  }
  async putAccount(a: Account) {
    this.data.accounts[a.id] = clone(a);
    this.save();
  }
  async patchAccount(id: string, patch: Partial<Pick<Account, "plan" | "name" | "bindings">>) {
    const a = this.data.accounts[id];
    if (!a) throw new Error("Account not found");
    Object.assign(a, clone(patch));
    this.save();
  }
  async listStudies(ownerId: string) {
    return clone(Object.values(this.data.studies).filter((s) => s.ownerId === ownerId).sort(byNewest));
  }
  async getStudy(id: string) {
    return clone(this.data.studies[id] ?? null);
  }
  async createStudy(s: Study) {
    if (this.data.studies[s.id]) throw new Error("Study exists");
    this.data.studies[s.id] = clone(s);
    this.save();
  }
  async patchStudy(id: string, patch: Partial<Study>) {
    const s = this.data.studies[id];
    if (!s) throw new Error("Study not found");
    Object.assign(s, clone(patch), { updatedAt: new Date().toISOString() });
    this.save();
  }
  async deleteStudy(id: string) {
    delete this.data.studies[id];
    this.save();
  }
  async listCollections(ownerId: string) {
    return clone(Object.values(this.data.collections).filter((c) => c.ownerId === ownerId).sort(byNewest));
  }
  async getCollection(id: string) {
    return clone(this.data.collections[id] ?? null);
  }
  async createCollection(c: Collection) {
    this.data.collections[c.id] = clone(c);
    this.save();
  }
  async patchCollection(id: string, patch: CollectionPatch) {
    const c = this.data.collections[id];
    if (!c) throw new Error("Collection not found");
    Object.assign(c, clone(patch), { updatedAt: new Date().toISOString() });
    this.save();
  }
  async deleteCollection(id: string) {
    delete this.data.collections[id];
    this.save();
  }
  async listShares(ownerId: string) {
    return clone(Object.values(this.data.shares).filter((s) => s.ownerId === ownerId).sort(byNewest));
  }
  async getShare(token: string) {
    return clone(this.data.shares[token] ?? null);
  }
  async createShare(s: Share) {
    this.data.shares[s.token] = clone(s);
    this.save();
  }
  async patchShare(token: string, patch: Partial<Share>) {
    const s = this.data.shares[token];
    if (!s) throw new Error("Share not found");
    Object.assign(s, clone(patch));
    this.save();
  }
  async createDeviceLink(link: DeviceLink) {
    this.data.deviceLinks[link.pollId] = clone(link);
    this.save();
  }
  async getDeviceLink(pollId: string) {
    return clone(this.data.deviceLinks[pollId] ?? null);
  }
  async findDeviceLinkByCode(userCode: string) {
    const hits = Object.values(this.data.deviceLinks).filter((l) => l.userCode === userCode);
    return clone(hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null);
  }
  async patchDeviceLink(pollId: string, patch: Partial<DeviceLink>) {
    const l = this.data.deviceLinks[pollId];
    if (!l) throw new Error("Device link not found");
    Object.assign(l, clone(patch));
    this.save();
  }
}

// ---------------------------------------------------------------------------

let instance: ViewerStore | null = null;

export function viewerStore(env: NodeJS.ProcessEnv = process.env): ViewerStore {
  if (instance) return instance;
  const fsCfg = firestoreConfig(env);
  if (fsCfg) {
    instance = new FirestoreStore(new FirestoreClient(fsCfg));
  } else {
    if (env.K_SERVICE && env.NEXT_PHASE !== "phase-production-build") {
      throw new Error("FIRESTORE_PROJECT is not set. Cloud Run refuses the in-memory viewer store.");
    }
    const file = env.VIEWER_STORE_FILE?.trim() || (env.NODE_ENV === "production" ? null : path.join(process.cwd(), ".data", "viewer-store.json"));
    instance = new MemoryStore(file);
  }
  return instance;
}

/** Test hook. */
export function setViewerStoreForTests(store: ViewerStore | null): void {
  instance = store;
}

/** Studies, collections and shares an owner holds, in one place for cascades. */
export async function deleteStudyCascade(store: ViewerStore, study: Study): Promise<void> {
  const [collections, shares] = await Promise.all([store.listCollections(study.ownerId), store.listShares(study.ownerId)]);
  await Promise.all([
    ...collections
      .filter((c) => c.studyIds.includes(study.id))
      .map((c) => store.patchCollection(c.id, { studyIds: c.studyIds.filter((id) => id !== study.id) })),
    ...shares
      .filter((s) => s.target.kind === "study" && s.target.studyId === study.id && !s.revokedAt)
      .map((s) => store.patchShare(s.token, { revokedAt: new Date().toISOString() })),
  ]);
  await store.deleteStudy(study.id);
}
