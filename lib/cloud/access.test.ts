import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeStoredStudyRead, invalidateAccess, resolveShare } from "./access.ts";
import { newShareToken, type Share } from "./shares.ts";
import { MemoryStore } from "./store.ts";
import type { Study } from "./types.ts";

function study(id: string, ownerId: string, uid: string, status: Study["status"] = "ready"): Study {
  const now = new Date().toISOString();
  return {
    id, ownerId, studyInstanceUID: uid, status, title: id, series: [], instanceCount: 1, bytes: 1,
    history: "h", findings: "f", diagnosis: "d", tags: [], markup: [], createdAt: now, updatedAt: now,
  };
}

function share(ownerId: string, target: Share["target"], extra: Partial<Share> = {}): Share {
  return { token: newShareToken(), ownerId, target, mode: "unknown", allowDownload: false, expiresAt: null, revokedAt: null, createdAt: new Date().toISOString(), ...extra };
}

test("owner reads own studies only; no session is 401", async () => {
  const store = new MemoryStore();
  await store.createStudy(study("s1", "alice", "2.25.1"));
  await store.createStudy(study("s2", "bob", "2.25.2"));
  assert.deepEqual(await authorizeStoredStudyRead({ userId: "alice", studyUid: "2.25.1" }, store), { ok: true });
  assert.deepEqual(await authorizeStoredStudyRead({ userId: "alice", studyUid: "2.25.2" }, store), { ok: false, status: 404 });
  assert.deepEqual(await authorizeStoredStudyRead({ studyUid: "2.25.1" }, store), { ok: false, status: 401 });
});

test("a study share grants that study only; revoke and expiry close it", async () => {
  const store = new MemoryStore();
  await store.createStudy(study("s1", "alice", "2.25.1"));
  await store.createStudy(study("s3", "alice", "2.25.3"));
  const sh = share("alice", { kind: "study", studyId: "s1" });
  await store.createShare(sh);
  assert.deepEqual(await authorizeStoredStudyRead({ shareToken: sh.token, studyUid: "2.25.1" }, store), { ok: true });
  assert.deepEqual(await authorizeStoredStudyRead({ shareToken: sh.token, studyUid: "2.25.3" }, store), { ok: false, status: 404 });

  await store.patchShare(sh.token, { revokedAt: new Date().toISOString() });
  invalidateAccess({ shareToken: sh.token });
  assert.deepEqual(await authorizeStoredStudyRead({ shareToken: sh.token, studyUid: "2.25.1" }, store), { ok: false, status: 404 });

  const expired = share("alice", { kind: "study", studyId: "s1" }, { expiresAt: "2000-01-01T00:00:00Z" });
  await store.createShare(expired);
  assert.equal(await resolveShare(expired.token, store), null);
});

test("a collection share grants its owner's ready studies, not someone else's", async () => {
  const store = new MemoryStore();
  await store.createStudy(study("s1", "alice", "2.25.1"));
  await store.createStudy(study("s2", "bob", "2.25.2"));
  await store.createStudy(study("s4", "alice", "2.25.4", "uploading"));
  const now = new Date().toISOString();
  await store.createCollection({ id: "c1", ownerId: "alice", name: "Chest", description: "", studyIds: ["s1", "s2", "s4"], createdAt: now, updatedAt: now });
  const sh = share("alice", { kind: "collection", collectionId: "c1" });
  await store.createShare(sh);
  const resolved = await resolveShare(sh.token, store);
  assert.deepEqual(resolved?.studies.map((s) => s.id), ["s1"]);
  assert.deepEqual(await authorizeStoredStudyRead({ shareToken: sh.token, studyUid: "2.25.2" }, store), { ok: false, status: 404 });
});

test("garbage tokens resolve to nothing", async () => {
  assert.equal(await resolveShare("../../x", new MemoryStore()), null);
});
