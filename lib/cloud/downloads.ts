// Desktop installer downloads (Windows, macOS).
//
// NOT LIVE YET (Sanyam, 2026-11): installers are offered only once builds are
// code-signed AND self-updating (Tauri updater, signed with the release key),
// so plan-gated features can ship later without a reinstall. Until then the
// site shows "coming soon". Two switches must BOTH be on for a link to appear:
//   1. DESKTOP_DOWNLOADS_LIVE=1 on the server (a person flips it), and
//   2. the manifest entry says `signed: true` (written by the release workflow
//      only after it checked the signing secrets; see desktop-release.yml).
//
// The release workflow (.github/workflows/desktop-release.yml) builds the
// installers and, when the GCS bucket is configured, uploads them with a small
// manifest: `gs://<bucket>/desktop/downloads.json`, public-read. The site reads
// that manifest (DOWNLOADS_MANIFEST_URL) and `/download/<platform>` redirects
// to the current installer. No manifest, or no entry for a platform, means the
// site says "not published yet" instead of linking to nothing.

export type DesktopPlatform = "windows" | "macos";
export const DESKTOP_PLATFORMS: readonly DesktopPlatform[] = ["windows", "macos"];

export interface InstallerEntry {
  url: string;
  fileName: string;
  bytes?: number;
  sha256?: string;
  /** Code-signed and update-signed (set by the release workflow's checks). */
  signed?: boolean;
}

export interface DownloadsManifest {
  version: string;
  publishedAt?: string;
  platforms: Partial<Record<DesktopPlatform, InstallerEntry>>;
}

export const PLATFORM_LABEL: Record<DesktopPlatform, string> = {
  windows: "Windows",
  macos: "macOS",
};

export function isDesktopPlatform(value: string): value is DesktopPlatform {
  return (DESKTOP_PLATFORMS as readonly string[]).includes(value);
}

/** Hosts an installer URL may point at. Anything else is dropped. */
export function allowedInstallerHost(host: string, extra: readonly string[] = []): boolean {
  const h = host.toLowerCase();
  return h === "storage.googleapis.com" || h.endsWith(".storage.googleapis.com") || extra.map((e) => e.toLowerCase()).includes(h);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Validate an untrusted manifest. Returns null when it is unusable; drops any
 * platform entry whose URL is not https on an allowed host.
 */
export function parseDownloadsManifest(raw: unknown, extraHosts: readonly string[] = []): DownloadsManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const version = str(obj.version);
  if (!version || !/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(version)) return null;
  const platformsRaw = (obj.platforms ?? {}) as Record<string, unknown>;
  const platforms: DownloadsManifest["platforms"] = {};
  for (const p of DESKTOP_PLATFORMS) {
    const e = platformsRaw[p] as Record<string, unknown> | undefined;
    const url = str(e?.url);
    const fileName = str(e?.fileName);
    if (!url || !fileName) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" || !allowedInstallerHost(parsed.hostname, extraHosts)) continue;
    const bytes = typeof e?.bytes === "number" && e.bytes > 0 ? e.bytes : undefined;
    const sha256 = str(e?.sha256);
    platforms[p] = {
      url: parsed.toString(),
      fileName,
      bytes,
      sha256: sha256 && /^[a-f0-9]{64}$/i.test(sha256) ? sha256 : undefined,
      signed: e?.signed === true,
    };
  }
  return { version, publishedAt: str(obj.publishedAt), platforms };
}

export function downloadsLive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DESKTOP_DOWNLOADS_LIVE?.trim() === "1";
}

/**
 * The installer to offer for `platform`, or null ("coming soon"). Requires the
 * live switch AND a signed entry: an unsigned or non-updating build is never
 * linked from the site, whatever the manifest says.
 */
export function offeredInstaller(
  manifest: DownloadsManifest | null,
  platform: DesktopPlatform,
  env: NodeJS.ProcessEnv = process.env
): InstallerEntry | null {
  if (!downloadsLive(env)) return null;
  const entry = manifest?.platforms[platform];
  return entry?.signed ? entry : null;
}

export function formatInstallerSize(bytes: number | undefined): string | null {
  if (!bytes) return null;
  return `${Math.round(bytes / 1e6)} MB`;
}

/** Fetch the manifest (cached 5 min by Next). Null when unset or unreachable. */
export async function loadDownloadsManifest(env: NodeJS.ProcessEnv = process.env): Promise<DownloadsManifest | null> {
  const url = env.DOWNLOADS_MANIFEST_URL?.trim();
  if (!url) return null;
  const extra = (env.DOWNLOADS_EXTRA_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const res = await fetch(url, { next: { revalidate: 300 }, signal: AbortSignal.timeout(3_000) } as RequestInit);
    if (!res.ok) return null;
    return parseDownloadsManifest(await res.json(), extra);
  } catch {
    return null;
  }
}
