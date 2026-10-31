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
//      A learner additionally needs a PUBLISHED case of that org to name the
//      study (lib/studyAccessPolicy.ts) — drafts' studies are author-only.
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
import { canAccessOrgResource } from "@/lib/authRoles";
import {
  DEFAULT_ORG_ID,
  getStudyByUID,
  listCasesForOrg,
  resolveShareAccess,
} from "@/lib/cases";
import {
  SHARE_COOKIE,
  isShareToken,
  shareGrantsStudy,
  studyUidsForCase,
} from "@/lib/caseShare";
import { studyReadAllowed } from "@/lib/studyAccessPolicy";
import { createTtlMemo } from "@/lib/ttlMemo";

const SESSION_TTL_MS = Number(process.env.DICOMWEB_SESSION_TTL_MS ?? 10_000);
type Caller = { orgId: string; canAuthor: boolean };
const sessionMemo = createTtlMemo<Caller | null>({
  ttlMs: SESSION_TTL_MS,
  maxEntries: 2_000,
});
const shareMemo = createTtlMemo<{ studyUids: string[] | null; orgId: string }>({
  ttlMs: 60_000,
  maxEntries: 5_000,
});
const ownershipMemo = createTtlMemo<boolean>({ ttlMs: 60_000, maxEntries: 5_000 });
/** Study UIDs named by an org's published cases (60 s; unpublish lags ≤ 60 s). */
const publishedMemo = createTtlMemo<Set<string>>({ ttlMs: 60_000, maxEntries: 500 });

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
async function caller(cookieHeader: string): Promise<Caller | null> {
  const hit = sessionMemo.get(cookieHeader);
  if (hit !== undefined) return hit;
  const session = await getSession();
  const value: Caller | null = session
    ? {
        orgId: session.user.activeOrgId || DEFAULT_ORG_ID,
        canAuthor: canAccessOrgResource({
          platformRole: session.user.platformRole,
          membershipRole: session.user.membershipRole,
          need: "author",
        }),
      }
    : null;
  sessionMemo.set(cookieHeader, value);
  return value;
}

async function publishedStudyUids(orgId: string): Promise<Set<string>> {
  const hit = publishedMemo.get(orgId);
  if (hit) return hit;
  const cases = await listCasesForOrg(orgId, { status: "published" });
  const uids = new Set(cases.flatMap((c) => studyUidsForCase(c)));
  publishedMemo.set(orgId, uids);
  return uids;
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
  if (shareOrg) {
    if (!(await orgOwnsStudy(shareOrg, studyUid))) return { ok: false, status: 404 };
    return { ok: true, orgId: shareOrg };
  }
  const who = await caller(req.headers.get("cookie") ?? "");
  if (!who) return { ok: false, status: 401 };
  const owns = await orgOwnsStudy(who.orgId, studyUid);
  const allowed = studyReadAllowed({
    canAuthor: who.canAuthor,
    orgOwnsStudy: owns,
    publishedStudyUids: owns && !who.canAuthor ? await publishedStudyUids(who.orgId) : new Set(),
    studyUid,
  });
  // 404, not 403: do not confirm a draft's study exists to a learner.
  if (!allowed) return { ok: false, status: 404 };
  return { ok: true, orgId: who.orgId };
}
