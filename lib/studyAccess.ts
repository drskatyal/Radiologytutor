// ============================================================================
// lib/studyAccess.ts  (server only)
//
// "May this request read pixels of this StudyInstanceUID?" — the one gate in
// front of every pixel route: /api/dicomweb (DICOMweb proxy) and
// /api/dicom-cdn (converted bundles: manifest, signed CDN prefix, chunk proxy).
//
//   1. A case-share cookie (`/s/[token]`) grants only the study UIDs that one
//      case names — no account, no archive-wide search.
//   2. Otherwise a signed-in session, and its active org must own the study.
//
// Never trusts a client-supplied orgId. Answers are memoised briefly because
// the DICOMweb route runs once per FRAME (lib/ttlMemo.ts):
//
//   session   keyed on the exact Cookie header. SHORT ttl
//             (DICOMWEB_SESSION_TTL_MS, default 10 s): a revoked session keeps
//             reading pixels for at most this long.
//   share     a /s/{token} link's org + study allowlist (60 s).
//   ownership does that org own this study (60 s; negatives cached too).
// ============================================================================

import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { DEFAULT_ORG_ID, getStudyByUID, resolveShareAccess } from "@/lib/cases";
import { SHARE_COOKIE, isShareToken, shareGrantsStudy } from "@/lib/caseShare";
import { createTtlMemo } from "@/lib/ttlMemo";

const SESSION_TTL_MS = Number(process.env.DICOMWEB_SESSION_TTL_MS ?? 10_000);
const sessionMemo = createTtlMemo<string | null>({
  ttlMs: SESSION_TTL_MS,
  maxEntries: 2_000,
});
const shareMemo = createTtlMemo<{ studyUids: string[] | null; orgId: string }>({
  ttlMs: 60_000,
  maxEntries: 5_000,
});
const ownershipMemo = createTtlMemo<boolean>({ ttlMs: 60_000, maxEntries: 5_000 });

/** Live share → org + study allowlist. Null study list means the token is dead. */
async function shareAllows(token: string, studyUid: string): Promise<string | null> {
  if (!isShareToken(token)) return null;
  let hit = shareMemo.get(token);
  if (!hit) {
    const access = await resolveShareAccess(token);
    hit = {
      orgId: access?.orgId ?? "",
      studyUids: access ? access.studyUids : null,
    };
    shareMemo.set(token, hit);
  }
  if (!hit.studyUids || !shareGrantsStudy(hit.studyUids, studyUid)) return null;
  return hit.orgId || null;
}

/**
 * Active org for the caller, or null when there is no session. Resolves the
 * session ONCE (a Better Auth read plus a domain-user read).
 */
async function callerOrgId(cookieHeader: string): Promise<string | null> {
  const hit = sessionMemo.get(cookieHeader);
  if (hit !== undefined) return hit;
  const session = await getSession();
  const orgId = session ? session.user.activeOrgId || DEFAULT_ORG_ID : null;
  sessionMemo.set(cookieHeader, orgId);
  return orgId;
}

async function orgOwnsStudy(orgId: string, studyUid: string): Promise<boolean> {
  const key = `${orgId}\u0000${studyUid}`;
  const hit = ownershipMemo.get(key);
  if (hit !== undefined) return hit;
  const owned = Boolean(await getStudyByUID(orgId, studyUid));
  ownershipMemo.set(key, owned);
  return owned;
}

export type StudyAccess =
  | { ok: true; orgId: string }
  | { ok: false; status: 401 | 404 };

/** Gate one study read. 401 without a session; 404 when the org does not own it. */
export async function authorizeStudyRead(req: NextRequest, studyUid: string): Promise<StudyAccess> {
  // Share cookie first, and only for the studies that case names. A leftover
  // cookie must not block a signed-in reader of a different study.
  const shareToken = req.cookies.get(SHARE_COOKIE)?.value;
  const shareOrg = shareToken ? await shareAllows(shareToken, studyUid) : null;
  let orgId = shareOrg;
  if (!orgId) {
    orgId = await callerOrgId(req.headers.get("cookie") ?? "");
    if (!orgId) return { ok: false, status: 401 };
  }
  if (!(await orgOwnsStudy(orgId, studyUid))) return { ok: false, status: 404 };
  return { ok: true, orgId };
}
