// The one module that knows whether we are inside the Tauri shell.
//
// Inside Tauri: native dialogs, the Rust scanner, the `dicom://` protocol,
// history/settings on disk. In a plain browser (`npm run dev` for UI work,
// Playwright smoke tests) the same calls degrade to the web adapter in
// `lib/localDicomFiles.ts` and localStorage, so the renderer is developed and
// tested against exactly one interface.

import type { DesktopHeader, ScanProgress, ScanResult } from "./types";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>, options?: { headers?: Record<string, string> }) => Promise<T>;

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);

let invokePromise: Promise<Invoke> | null = null;
function tauriInvoke(): Promise<Invoke> {
  invokePromise ??= import("@tauri-apps/api/core").then((m) => m.invoke as Invoke);
  return invokePromise;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const fn = await tauriInvoke();
  return fn<T>(cmd, args);
}

/** `dicom://localhost/f/<id>` on macOS/Linux, `http://dicom.localhost/f/<id>` on Windows. */
let protocolBase: string | null = null;
export async function initProtocol(): Promise<void> {
  if (!isTauri) return;
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  protocolBase = convertFileSrc("f", "dicom").replace(/f$/, "f/");
}

export function imageUrlFor(fileId: number): string {
  if (!protocolBase) throw new Error("dicom protocol not initialised");
  return `${protocolBase}${fileId}`;
}

export async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => handler(e.payload));
}

// ───────────────────────────── dialogs ─────────────────────────────

export async function pickFolder(title = "Open a study folder"): Promise<string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title });
  if (!picked) return null;
  return Array.isArray(picked) ? picked : [picked];
}

export async function pickFiles(kind: "dicom" | "zip" | "dicomdir"): Promise<string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const filters =
    kind === "zip"
      ? [{ name: "Zip archive", extensions: ["zip"] }]
      : kind === "dicomdir"
        ? [{ name: "DICOMDIR", extensions: ["*"] }]
        : [
            { name: "DICOM files", extensions: ["dcm", "dicom", "dic", "ima", "*"] },
          ];
  const picked = await open({
    multiple: kind === "dicom",
    directory: false,
    filters,
    title: kind === "zip" ? "Open a zip archive" : kind === "dicomdir" ? "Open a DICOMDIR" : "Open DICOM files",
  });
  if (!picked) return null;
  return Array.isArray(picked) ? picked : [picked];
}

export async function pickSavePath(defaultName: string, extensions: string[], name: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: defaultName, filters: [{ name, extensions }] });
}

// ───────────────────────────── scanning ─────────────────────────────

export interface ScanHandlers {
  onProgress?: (p: ScanProgress) => void;
  onBatch?: (headers: DesktopHeader[]) => void;
}

export async function scanPaths(paths: string[], handlers: ScanHandlers = {}): Promise<ScanResult> {
  const off = await Promise.all([
    listen<ScanProgress>("scan-progress", (p) => handlers.onProgress?.(p)),
    listen<DesktopHeader[]>("scan-batch", (b) => handlers.onBatch?.(b)),
  ]);
  try {
    return await invoke<ScanResult>("scan_sources", { paths });
  } finally {
    off.forEach((fn) => fn());
  }
}

export async function cancelScan(): Promise<void> {
  if (isTauri) await invoke("cancel_scan");
}

export interface MediaVolume {
  path: string;
  label: string;
  kind: "optical" | "removable";
  hasDicomdir: boolean;
}

export async function listMedia(): Promise<MediaVolume[]> {
  if (!isTauri) return [];
  return invoke<MediaVolume[]>("list_media");
}

export async function takeLaunchPaths(): Promise<string[]> {
  if (!isTauri) return [];
  return invoke<string[]>("take_launch_paths");
}

// ───────────────────────────── persistence ─────────────────────────────

const LS_HISTORY = "radlearn-viewer.history";
const LS_SETTINGS = "radlearn-viewer.settings";

function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode — nothing to persist */
  }
}

export async function historyList<T>(): Promise<T[]> {
  if (!isTauri) return lsGet<T[]>(LS_HISTORY, []);
  return invoke<T[]>("history_list");
}

export async function historyRecord<T extends { key: string }>(entry: T): Promise<T[]> {
  if (!isTauri) {
    const list = [entry, ...lsGet<T[]>(LS_HISTORY, []).filter((e) => e.key !== entry.key)].slice(0, 100);
    lsSet(LS_HISTORY, list);
    return list;
  }
  return invoke<T[]>("history_record", { entry });
}

export async function historyRemove<T>(key: string): Promise<T[]> {
  if (!isTauri) {
    const list = lsGet<(T & { key: string })[]>(LS_HISTORY, []).filter((e) => e.key !== key);
    lsSet(LS_HISTORY, list);
    return list;
  }
  return invoke<T[]>("history_remove", { key });
}

export async function historyClear(): Promise<void> {
  if (!isTauri) return lsSet(LS_HISTORY, []);
  await invoke("history_clear");
}

export async function settingsGet<T>(): Promise<Partial<T>> {
  if (!isTauri) return lsGet<Partial<T>>(LS_SETTINGS, {});
  return invoke<Partial<T>>("settings_get");
}

export async function settingsSet<T>(patch: Partial<T>): Promise<Partial<T>> {
  if (!isTauri) {
    const next = { ...lsGet<Partial<T>>(LS_SETTINGS, {}), ...patch };
    lsSet(LS_SETTINGS, next);
    return next;
  }
  return invoke<Partial<T>>("settings_set", { patch });
}

export async function cacheUsage(): Promise<number> {
  if (!isTauri) return 0;
  return invoke<number>("cache_usage");
}

export async function clearCache(): Promise<void> {
  if (isTauri) await invoke("clear_cache");
}

// ───────────────────────────── export ─────────────────────────────

/** Save bytes the renderer produced. Raw IPC body; never JSON-encoded. */
export async function writeExport(path: string, bytes: Uint8Array): Promise<void> {
  if (!isTauri) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    const a = document.createElement("a");
    a.href = url;
    a.download = path.split(/[\\/]/).pop() || "export";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }
  const fn = await tauriInvoke();
  await (fn as unknown as (c: string, b: Uint8Array, o: { headers: Record<string, string> }) => Promise<void>)(
    "write_export",
    bytes,
    { headers: { "x-export-path": encodeURIComponent(path) } }
  );
}

// ───────────────────────────── benchmark ─────────────────────────────

export async function benchEnabled(): Promise<boolean> {
  if (!isTauri) return new URLSearchParams(location.search).has("bench");
  return invoke<boolean>("bench_enabled");
}

export async function benchReport(report: Record<string, unknown>): Promise<void> {
  if (!isTauri) {
    console.info("RADLEARN_BENCH", JSON.stringify(report));
    (window as unknown as { __radlearnBench?: unknown }).__radlearnBench = report;
    return;
  }
  await invoke("bench_report", { report });
}

export async function appVersion(): Promise<string> {
  if (!isTauri) return "web";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}
