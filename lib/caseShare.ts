/**
 * Plain case-library shares. A token URL opens the DICOM viewer.
 * Teaching (LiveTeachingPack, mic, examiner) is a different open mode.
 *
 * Tokens are 256-bit, URL-safe, and unguessable. The cookie that rides
 * along on `/s/[token]` is only a copy of that secret so the viewer can
 * fetch pixels without an account. Revocation is a data-layer flag.
 */

export const SHARE_COOKIE = "flowrad_share";
/** Capability cookie lifetime. A revoked token fails the lookup before this. */
export const SHARE_COOKIE_MAX_AGE_SEC = 60 * 60 * 12;

/** 32 bytes of base64url, no padding → 43 characters. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export type CaseOpenMode = "view" | "teach" | "exam";

export function isShareToken(value: string | undefined | null): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

export function generateShareToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function sharePath(token: string): string {
  return `/s/${token}`;
}

/** Pull a well-formed token out of a request path. Anything else is ignored. */
export function tokenFromSharePath(pathname: string): string | null {
  const match = /^\/s\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return null;
  let token = match[1];
  try {
    token = decodeURIComponent(token);
  } catch {
    return null;
  }
  return isShareToken(token) ? token : null;
}

export function shareCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SHARE_COOKIE_MAX_AGE_SEC,
  };
}

/**
 * How `/case/[id]` should open.
 * Missing and unknown values stay on teach so existing links keep the tutor.
 * `view` is the locker / share path: pixels, tools, no attending.
 */
export function caseOpenMode(mode: string | undefined | null): CaseOpenMode {
  const value = mode?.trim().toLowerCase();
  if (value === "view" || value === "viewer" || value === "read") return "view";
  if (value === "exam" || value === "examiner" || value === "viva") return "exam";
  return "teach";
}

export function caseViewHref(caseId: string): string {
  return `/case/${encodeURIComponent(caseId)}?mode=view`;
}

export function caseTeachHref(caseId: string): string {
  return `/case/${encodeURIComponent(caseId)}?mode=teach`;
}

export function caseHasTeachingPack(caseData: {
  liveTeachingPack?: { findings?: readonly unknown[] } | null;
}): boolean {
  return (caseData.liveTeachingPack?.findings?.length ?? 0) > 0;
}

/** Locker row actions. View is always there. Teach only when a pack exists. */
export function lockerActions(input: { hasPack: boolean; canManageShare: boolean }): {
  view: true;
  teach: boolean;
  share: boolean;
} {
  return {
    view: true,
    teach: input.hasPack,
    share: input.canManageShare,
  };
}

/**
 * Viewer chrome. A shared link never offers Teach — the recipient came to
 * see the study. Share management stays with the teacher on their own pages.
 */
export function viewerChrome(input: { hasPack: boolean; canManageShare: boolean; sharedLink: boolean }): {
  showTeach: boolean;
  showShare: boolean;
} {
  if (input.sharedLink) return { showTeach: false, showShare: false };
  return {
    showTeach: input.hasPack,
    showShare: input.canManageShare,
  };
}

export function studyUidsForCase(caseData: {
  studyRefs?: readonly { studyInstanceUID?: string | null }[] | null;
  findings?: readonly { studyInstanceUID?: string | null }[] | null;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (uid: string | null | undefined) => {
    const value = uid?.trim() ?? "";
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  for (const ref of caseData.studyRefs ?? []) add(ref.studyInstanceUID);
  for (const finding of caseData.findings ?? []) add(finding.studyInstanceUID);
  return out;
}

export function shareGrantsStudy(studyUids: readonly string[], studyUid: string): boolean {
  const want = studyUid.trim();
  return want.length > 0 && studyUids.includes(want);
}

export function activeShare<T extends { revokedAt?: string | null; createdAt: string }>(
  shares: readonly T[]
): T | null {
  let best: T | null = null;
  for (const share of shares) {
    if (share.revokedAt) continue;
    if (!best || share.createdAt > best.createdAt) best = share;
  }
  return best;
}
