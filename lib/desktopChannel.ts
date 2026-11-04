// ============================================================================
// lib/desktopChannel.ts — the desktop viewer's update channel and remote config.
//
// FlowRad Viewer (desktop) asks this site, with no parameters and no
// identifying headers, three things (docs/UPDATES.md):
//
//   GET /api/desktop/update            the Tauri updater manifest (latest.json)
//   GET /api/desktop/update/rollback   the PREVIOUS release's manifest, used
//                                      only when a new version fails to start
//   GET /api/desktop/config            signed feature flags / paid features
//
// Each value below is `null` until a person rolls a release out: shipping an
// update is a reviewed PR that pastes the signed latest.json from the draft
// release into LATEST (after the HP test passes and the release is published).
// `null` answers 204 No Content, which the app reads as "nothing new", so an
// update can also be pulled instantly by setting LATEST back to null.
//
// Nothing here is secret: manifests and the config are signed with the
// updater's ed25519 (minisign) key, and the app verifies every byte against
// the public key baked into it. A tampered response is ignored by the app.
// ============================================================================

/** One platform entry of a Tauri v2 updater manifest. */
export interface DesktopPlatformEntry {
  /** Base64 minisign signature of the update bundle (the `.sig` file's text). */
  signature: string;
  /** Public HTTPS URL of the bundle (.msi/.exe for Windows, .app.tar.gz for macOS). */
  url: string;
}

/** Tauri v2 updater manifest (what `tauri-action` writes as latest.json). */
export interface DesktopUpdateManifest {
  version: string;
  notes?: string;
  pub_date?: string;
  /** e.g. "windows-x86_64", "darwin-aarch64", "darwin-x86_64". */
  platforms: Record<string, DesktopPlatformEntry>;
}

/**
 * A signed remote config: `payload` is the exact JSON text that was signed
 * (`tauri signer sign`), `signature` the base64 minisign signature of it.
 */
export interface SignedEnvelope {
  payload: string;
  signature: string;
}

/** The release users are offered. `null`: no rollout in progress. */
export const LATEST: DesktopUpdateManifest | null = null;

/** The release a failed update rolls back to (the one before LATEST). */
export const ROLLBACK: DesktopUpdateManifest | null = null;

/** Signed feature flags / paid-feature list. `null`: the app's defaults (all free). */
export const REMOTE_CONFIG: SignedEnvelope | null = null;

/** Shape check before serving, so a bad paste fails CI instead of every client. */
export function isManifest(value: unknown): value is DesktopUpdateManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<DesktopUpdateManifest>;
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+/.test(m.version)) return false;
  if (!m.platforms || typeof m.platforms !== "object") return false;
  const entries = Object.entries(m.platforms);
  if (entries.length === 0) return false;
  return entries.every(
    ([key, e]) =>
      /^(windows|darwin|linux)-(x86_64|aarch64|i686|armv7)$/.test(key) &&
      !!e &&
      typeof e.signature === "string" &&
      e.signature.length > 40 &&
      typeof e.url === "string" &&
      e.url.startsWith("https://")
  );
}

export function isEnvelope(value: unknown): value is SignedEnvelope {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<SignedEnvelope>;
  if (typeof e.payload !== "string" || typeof e.signature !== "string") return false;
  try {
    JSON.parse(e.payload);
  } catch {
    return false;
  }
  return e.signature.length > 40;
}

/** What a channel route answers: JSON when set and well-formed, else 204. */
export function channelResponse(value: unknown, valid: (v: unknown) => boolean): Response {
  const headers = { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" };
  if (value === null || !valid(value)) return new Response(null, { status: 204, headers });
  return new Response(JSON.stringify(value), { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
}
