// Several viewer windows as one reading station.
//
// Desktop (Tauri): each secondary window is its own webview (`viewer-<n>`),
// opened on a chosen monitor by the Rust shell; windows talk over Tauri
// events. Browser (dev / e2e, and the web app's pop-out): `window.open` plus a
// BroadcastChannel. The messages and the geometry are the viewer core's
// (`crossWindow.ts`); this file is only the transport and the handoff.

import { isWindowSyncMessage, type MonitorInfo, type WindowSyncMessage } from "@flowrad/viewer-core";
import { invoke, isTauri } from "./platform";
import type { DesktopHeader } from "./types";

/** This window's id: "main", or the secondary window's label. */
export const windowId: string = (() => {
  try {
    return new URLSearchParams(location.search).get("window") || "main";
  } catch {
    return "main";
  }
})();
export const isSecondaryWindow = windowId !== "main";

/** What a secondary window shows. Desktop passes scanned headers; the browser passes the files. */
export interface WindowHandoff {
  sourceLabel: string;
  studyKey?: string;
  rows: number;
  cols: number;
  cells: (string | null)[];
  activeCell: number;
  links: { scroll: boolean; voi: boolean; zoom: boolean; referenceLines: boolean };
  /** Registration offsets (mm) by first imageId, so a registered prior stays registered. */
  offsets?: Record<string, number>;
  headers?: DesktopHeader[];
  documents?: unknown[];
  files?: File[];
}

const EVENT = "viewer-sync";
const CHANNEL = "flowrad-viewer-sync";

type Unsubscribe = () => void;

/** Send to every other viewer window. */
export function postToWindows(message: WindowSyncMessage): void {
  if (isTauri) {
    void import("@tauri-apps/api/event").then(({ emit }) => emit(EVENT, message)).catch(() => undefined);
  } else {
    channel()?.postMessage(message);
  }
}

/** Messages from the other windows (never this window's own). */
export function onWindowMessage(fn: (message: WindowSyncMessage) => void): Unsubscribe {
  const handle = (value: unknown) => {
    if (isWindowSyncMessage(value) && value.from !== windowId) fn(value);
  };
  if (isTauri) {
    let off: Unsubscribe | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen(EVENT, (e) => handle(e.payload)).then((un) => {
        if (cancelled) un();
        else off = un;
      })
    );
    return () => {
      cancelled = true;
      off?.();
    };
  }
  const ch = channel();
  if (!ch) return () => undefined;
  const listener = (e: MessageEvent) => handle(e.data);
  ch.addEventListener("message", listener);
  return () => ch.removeEventListener("message", listener);
}

let bc: BroadcastChannel | null | undefined;
function channel(): BroadcastChannel | null {
  if (bc === undefined) bc = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
  return bc;
}

/**
 * e2e only (browser mode): a pretend desk, so the monitor picker can be driven
 * without a second screen. Never set by the app.
 */
function testMonitors(): MonitorInfo[] | null {
  const t = (window as unknown as { __flowradTestMonitors?: MonitorInfo[] }).__flowradTestMonitors;
  return Array.isArray(t) && t.length ? t : null;
}

/** Whether this build can see monitors (desktop, or the e2e pretend desk). */
export function monitorsAvailable(): boolean {
  return isTauri || !!testMonitors();
}

/** Monitors attached now (desktop). The browser cannot place windows on a screen. */
export async function listMonitors(): Promise<MonitorInfo[]> {
  if (!isTauri) return testMonitors() ?? [];
  try {
    return await invoke<MonitorInfo[]>("list_monitors");
  } catch {
    return [];
  }
}

/** The monitor this window is on (desktop). */
export async function currentMonitorName(label = windowId): Promise<string | undefined> {
  if (!isTauri) return testMonitors()?.[label === "main" ? 0 : 1]?.name;
  try {
    return (await invoke<string | null>("window_monitor", { label })) ?? undefined;
  } catch {
    return undefined;
  }
}

let popoutSeq = 0;
const pendingPopouts = new Map<string, WindowHandoff>();

/**
 * Open a viewer window showing `handoff`, on `monitor` (desktop) or as a new
 * browser window (pop-out). Returns the new window's id, or null when the
 * browser blocked the pop-up.
 */
export async function openViewerWindow(handoff: WindowHandoff, monitor?: MonitorInfo | null, label?: string): Promise<string | null> {
  if (isTauri) {
    const open = await invoke<string[]>("viewer_windows").catch(() => [] as string[]);
    const id = label ?? nextLabel(open);
    await invoke("open_viewer_window", {
      label: id,
      monitor: monitor?.name ?? null,
      payload: JSON.stringify(handoff),
      title: `FlowRad Viewer · ${handoff.sourceLabel}`,
    });
    return id;
  }
  const id = label ?? `popout-${Date.now().toString(36)}-${++popoutSeq}`;
  pendingPopouts.set(id, handoff);
  ensurePopoutServer();
  const url = new URL(location.href);
  url.search = `?window=${encodeURIComponent(id)}`;
  const w = window.open(url.toString(), id, "popup,width=1200,height=800");
  if (!w) {
    pendingPopouts.delete(id);
    return null;
  }
  return id;
}

function nextLabel(open: string[]): string {
  for (let n = 2; ; n += 1) if (!open.includes(`viewer-${n}`)) return `viewer-${n}`;
}

// Browser pop-outs ask the opener for their handoff (files are structured-cloned).
let popoutServer = false;
function ensurePopoutServer() {
  if (popoutServer) return;
  popoutServer = true;
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    const ask = e.data as { kind?: string; id?: string } | null;
    if (ask?.kind !== "flowrad-handoff-request" || !ask.id) return;
    const handoff = pendingPopouts.get(ask.id);
    if (!handoff) return;
    pendingPopouts.delete(ask.id);
    (e.source as Window | null)?.postMessage({ kind: "flowrad-handoff", id: ask.id, handoff }, location.origin);
  });
}

/** The secondary window's handoff (once), or null for the main window. */
export async function takeHandoff(): Promise<WindowHandoff | null> {
  if (!isSecondaryWindow) return null;
  if (isTauri) {
    const raw = await invoke<string | null>("take_window_payload", { label: windowId }).catch(() => null);
    return raw ? (JSON.parse(raw) as WindowHandoff) : null;
  }
  const opener = window.opener as Window | null;
  if (!opener) return null;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), 10_000);
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { kind?: string; id?: string; handoff?: WindowHandoff } | null;
      if (e.origin !== location.origin || m?.kind !== "flowrad-handoff" || m.id !== windowId) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(m.handoff ?? null);
    };
    window.addEventListener("message", onMessage);
    opener.postMessage({ kind: "flowrad-handoff-request", id: windowId }, location.origin);
  });
}

/** Desktop: a moved/re-sent window reloads its handoff. */
export function onHandoffChanged(fn: () => void): Unsubscribe {
  if (!isTauri || !isSecondaryWindow) return () => undefined;
  let off: Unsubscribe | null = null;
  let cancelled = false;
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen("viewer-handoff", () => fn()).then((un) => {
      if (cancelled) un();
      else off = un;
    })
  );
  return () => {
    cancelled = true;
    off?.();
  };
}

/** Tell the others this window is going (reference lines from it disappear). */
export function announceClosing(): void {
  postToWindows({ kind: "closed", from: windowId });
}
