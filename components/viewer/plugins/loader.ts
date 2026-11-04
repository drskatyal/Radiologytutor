"use client";

// Load one viewer plugin: fetch the module, check its SHA-256 against the
// pin from the server config (lib/pluginConfig.ts), and only then import it
// from a blob: URL, so the bytes that run are exactly the bytes that were
// checked. A changed file at the same URL is refused.

import { validatePlugin, type FlowradViewerPlugin } from "@flowrad/viewer-core";
import type { PluginSource } from "@/lib/pluginConfig";

const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadPlugin(source: PluginSource): Promise<FlowradViewerPlugin> {
  const res = await fetch(source.url, { credentials: "omit", cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not fetch the plugin (${res.status}).`);
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_PLUGIN_BYTES) throw new Error("The plugin file is larger than 2 MB.");
  if ((await sha256Hex(bytes)) !== source.sha256) throw new Error("The plugin file does not match its pinned SHA-256. Not loaded.");
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
  try {
    const mod = (await import(/* webpackIgnore: true */ url)) as { default?: unknown };
    const plugin = validatePlugin(mod.default);
    if (typeof plugin === "string") throw new Error(plugin);
    if (plugin.id !== source.id) throw new Error(`The file declares plugin "${plugin.id}", not "${source.id}".`);
    return plugin;
  } finally {
    URL.revokeObjectURL(url);
  }
}
