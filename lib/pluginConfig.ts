// Which viewer plugins this deployment loads. OFF BY DEFAULT: with no
// configuration the viewer renders exactly as before (no panel, no fetches).
//
//   VIEWER_PLUGINS_ENABLED=1
//   VIEWER_PLUGINS='[{"id":"teaching-tools","url":"https://plugins.flowrad.ai/teaching-tools/1.0.0/index.js","sha256":"<64 hex>"}]'
//   VIEWER_PLUGIN_HOSTS=plugins.flowrad.ai          (comma-separated allowlist; same-origin "/..." paths always allowed)
//
// Every plugin is pinned by SHA-256: the browser fetches the module, checks
// the hash, and only then imports it (components/viewer/plugins/loader.ts).
// A changed file at the same URL is refused. Plugins run with the viewer's
// privileges, so only allowlisted, reviewed code from the plugins repository
// belongs here.

export interface PluginSource {
  id: string;
  url: string;
  sha256: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export function viewerPluginConfig(env: NodeJS.ProcessEnv = process.env): { sources: PluginSource[]; problems: string[] } {
  if (env.VIEWER_PLUGINS_ENABLED?.trim() !== "1") return { sources: [], problems: [] };
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(env.VIEWER_PLUGINS?.trim() || "[]");
  } catch {
    return { sources: [], problems: ["VIEWER_PLUGINS is not valid JSON."] };
  }
  if (!Array.isArray(raw)) return { sources: [], problems: ["VIEWER_PLUGINS must be a JSON array."] };
  const hosts = new Set((env.VIEWER_PLUGIN_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
  const sources: PluginSource[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 20)) {
    const e = (item ?? {}) as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    const url = typeof e.url === "string" ? e.url.trim() : "";
    const sha256 = typeof e.sha256 === "string" ? e.sha256.trim().toLowerCase() : "";
    if (!ID_RE.test(id)) {
      problems.push(`Plugin id "${id}" is not valid.`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`Plugin "${id}" is listed twice.`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      problems.push(`Plugin "${id}" has no sha256 pin.`);
      continue;
    }
    let ok = false;
    if (url.startsWith("/") && !url.startsWith("//")) ok = true;
    else {
      try {
        const u = new URL(url);
        ok = u.protocol === "https:" && hosts.has(u.hostname.toLowerCase()) && !u.username && !u.password;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      problems.push(`Plugin "${id}" URL must be same-origin or https on an allowlisted host (VIEWER_PLUGIN_HOSTS).`);
      continue;
    }
    seen.add(id);
    sources.push({ id, url, sha256 });
  }
  return { sources, problems };
}
