// Who may read which stored study.
//
//   • The OWNER (signed-in session) reads their own studies.
//   • A SHARE token reads only the studies its target names: one study, or the
//     studies in one collection, owned by the share's creator. A revoked or
//     expired token reads nothing.
//
// The token rides in the DICOMweb path (/api/dicomweb/s/<token>/studies/...),
// so share links and embeds need no cookie. Results are memoised briefly so a
// scroll through 500 frames is not 500 store reads; revoke takes effect within
// ACCESS_TTL_MS.

import { createTtlMemo } from "@/lib/ttlMemo";
import { isShareToken, shareIsLive, type Share } from "./shares";
import { viewerStore, type ViewerStore } from "./store";
import type { Collection, Study } from "./types";

const ACCESS_TTL_MS = 15_000;

export interface ResolvedShare {
  share: Share;
  studies: Study[];
  collection: Collection | null;
}

/** A live share and the ready studies it grants, or null. */
export async function resolveShare(token: string, store: ViewerStore = viewerStore(), now = Date.now()): Promise<ResolvedShare | null> {
  if (!isShareToken(token)) return null;
  const share = await store.getShare(token);
  if (!share || !shareIsLive(share, now)) return null;
  if (share.target.kind === "study") {
    const study = await store.getStudy(share.target.studyId);
    if (!study || study.ownerId !== share.ownerId || study.status !== "ready") return null;
    return { share, studies: [study], collection: null };
  }
  const collection = await store.getCollection(share.target.collectionId);
  if (!collection || collection.ownerId !== share.ownerId) return null;
  const studies = (await Promise.all(collection.studyIds.map((id) => store.getStudy(id)))).filter(
    (s): s is Study => Boolean(s && s.ownerId === share.ownerId && s.status === "ready")
  );
  return { share, studies, collection };
}

const shareMemo = createTtlMemo<string[] | null>({ ttlMs: ACCESS_TTL_MS, maxEntries: 5_000 });
const ownerMemo = createTtlMemo<string[]>({ ttlMs: ACCESS_TTL_MS, maxEntries: 2_000 });

export type ReadAccess = { ok: true } | { ok: false; status: 401 | 404 };

/** Gate one DICOMweb read of `studyUid`. */
export async function authorizeStoredStudyRead(
  input: { shareToken?: string | null; userId?: string | null; studyUid: string },
  store: ViewerStore = viewerStore()
): Promise<ReadAccess> {
  if (input.shareToken) {
    let uids = shareMemo.get(input.shareToken);
    if (uids === undefined) {
      const resolved = await resolveShare(input.shareToken, store);
      uids = resolved ? resolved.studies.map((s) => s.studyInstanceUID) : null;
      shareMemo.set(input.shareToken, uids);
    }
    return uids?.includes(input.studyUid) ? { ok: true } : { ok: false, status: 404 };
  }
  if (!input.userId) return { ok: false, status: 401 };
  let owned = ownerMemo.get(input.userId);
  if (!owned) {
    // Uploading studies are readable by the owner (the upload preview).
    owned = (await store.listStudies(input.userId)).map((s) => s.studyInstanceUID);
    ownerMemo.set(input.userId, owned);
  }
  return owned.includes(input.studyUid) ? { ok: true } : { ok: false, status: 404 };
}

/** Forget memoised grants (after a revoke, delete or new upload). */
export function invalidateAccess(opts: { shareToken?: string; userId?: string }): void {
  if (opts.shareToken) shareMemo.delete(opts.shareToken);
  if (opts.userId) ownerMemo.delete(opts.userId);
}
