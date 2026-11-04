// Share links: view-only, either an "unknown" (findings hidden) or "with
// findings", optionally expiring, always revocable. Pure logic: no store and
// no Next imports, so it is unit-tested directly.

export type ShareMode = "unknown" | "findings";
export type ShareTarget = { kind: "study"; studyId: string } | { kind: "collection"; collectionId: string };

export interface Share {
  token: string;
  ownerId: string;
  target: ShareTarget;
  mode: ShareMode;
  /** Shared viewers may download the anonymised DICOM. */
  allowDownload: boolean;
  /** ISO time after which the link stops working. Null = no expiry. */
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Expiry choices offered in the share dialog (null = never). */
export const EXPIRY_CHOICES = [
  { id: "1d", label: "1 day", ms: 86_400_000 },
  { id: "7d", label: "7 days", ms: 7 * 86_400_000 },
  { id: "30d", label: "30 days", ms: 30 * 86_400_000 },
  { id: "never", label: "Never", ms: null },
] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]["id"];

const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** 24 random bytes, base64url (32 chars). Unguessable: the token IS the grant. */
export function newShareToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

export function expiryFromChoice(choice: string, now = Date.now()): string | null {
  const hit = EXPIRY_CHOICES.find((c) => c.id === choice);
  if (!hit) throw new Error(`Unknown expiry: ${choice}`);
  return hit.ms == null ? null : new Date(now + hit.ms).toISOString();
}

export type ShareStatus = "active" | "expired" | "revoked";

export function shareStatus(share: Pick<Share, "expiresAt" | "revokedAt">, now = Date.now()): ShareStatus {
  if (share.revokedAt) return "revoked";
  if (share.expiresAt && Date.parse(share.expiresAt) <= now) return "expired";
  return "active";
}

export function shareIsLive(share: Pick<Share, "expiresAt" | "revokedAt">, now = Date.now()): boolean {
  return shareStatus(share, now) === "active";
}

/** Path a share opens at. Embeds use the chrome-less route. */
export function sharePath(token: string, embed = false): string {
  return embed ? `/embed/${token}` : `/s/${token}`;
}

/**
 * DICOMweb root a share viewer reads through. The token is in the PATH, not a
 * cookie, so a shared study works inside a third-party iframe (embeds), where
 * browsers block cookies.
 */
export function shareDicomwebRoot(token: string): string {
  return `/api/dicomweb/s/${token}`;
}

export function embedSnippet(origin: string, token: string): string {
  const src = `${origin.replace(/\/+$/, "")}${sharePath(token, true)}`;
  return `<iframe src="${src}" width="800" height="600" style="border:0" allow="fullscreen" title="FlowRad Viewer study"></iframe>`;
}

/** The teaching text that travels with a study. */
export interface StudyTeachingText {
  history: string;
  findings: string;
  diagnosis: string;
  tags: string[];
}

/** What a share viewer may see of it. */
export function visibleTeachingText(text: StudyTeachingText, mode: ShareMode): StudyTeachingText {
  if (mode === "findings") return text;
  // An unknown shows the clinical history only: the reader works the case.
  return { history: text.history, findings: "", diagnosis: "", tags: [] };
}

/** Markup (annotations) is part of the answer, so unknowns hide it too. */
export function markupVisible(mode: ShareMode): boolean {
  return mode === "findings";
}
