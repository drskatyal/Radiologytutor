// Which monitors are attached, kept current as they are plugged in or out.
//
// The multi-monitor UI (send to monitor, the picker, Mod+Shift+N / Mod+Alt+N,
// the window badge) is offered only with two or more monitors, so the count
// must follow the desk live. Re-reading the list is cheap (one shell call),
// and it happens only when something can have changed:
//
//   - the window gains focus, becomes visible, is moved or changes scale
//     (unplugging the monitor a window is on moves it);
//   - the screen reports a change (`screen` "change": WebView2 / Chromium fire
//     it on WM_DISPLAYCHANGE, e.g. when `screen.isExtended` flips);
//   - only where no such event exists (WKWebView, WebKitGTK), a slow poll —
//     and only while the window is visible and a study is open, the only time
//     the multi-monitor UI is on screen.
//
// Nothing runs on the start screen or in a hidden / minimised window, and an
// unchanged list never re-renders. Windows already open on a monitor that goes
// away are left alone: the OS moves them, they keep working.

import type { MonitorInfo } from "@flowrad/viewer-core";

/** Fallback poll where the screen has no change event. */
export const MONITOR_POLL_MS = 5_000;

/** The multi-monitor UI is offered only with at least two monitors. */
export function hasMultipleMonitors(monitors: readonly MonitorInfo[]): boolean {
  return monitors.length > 1;
}

/** Same desk (names, placement, size and scale, in order)? Avoids re-rendering on an unchanged poll. */
export function sameMonitors(a: readonly MonitorInfo[], b: readonly MonitorInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const o = b[i]!;
    return m.name === o.name && m.x === o.x && m.y === o.y && m.width === o.width && m.height === o.height && m.scale === o.scale;
  });
}

/** Does this engine tell us when the screens change? (Chromium / WebView2: yes; WebKit: no.) */
export function screenChangeEventSupported(scr: unknown = typeof screen === "undefined" ? undefined : screen): boolean {
  return !!scr && typeof (scr as EventTarget).addEventListener === "function" && "onchange" in (scr as object);
}

/** Should the fallback poll run now? */
export function shouldPollMonitors(opts: { eventSupported: boolean; visible: boolean; active: boolean }): boolean {
  return !opts.eventSupported && opts.visible && opts.active;
}

export interface MonitorWatchOptions {
  /** Re-read the monitors (debounced by the caller's events). */
  refresh: () => void;
  /** A study is open: the multi-monitor UI can be on screen. */
  active: boolean;
  /** Desktop: also listen to the Tauri window's move / scale events. */
  tauri: boolean;
}

/** Start watching; returns the stop function. */
export function watchMonitors({ refresh, active, tauri }: MonitorWatchOptions): () => void {
  let stopped = false;
  let debounce = 0;
  let poll = 0;
  const later = () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => !stopped && refresh(), 300);
  };
  const eventSupported = screenChangeEventSupported();
  const syncPoll = () => {
    const want = shouldPollMonitors({ eventSupported, visible: document.visibilityState === "visible", active });
    if (want && !poll) poll = window.setInterval(() => !stopped && refresh(), MONITOR_POLL_MS);
    if (!want && poll) {
      window.clearInterval(poll);
      poll = 0;
    }
  };
  const onVisibility = () => {
    syncPoll();
    if (document.visibilityState === "visible") later();
  };

  window.addEventListener("focus", later);
  document.addEventListener("visibilitychange", onVisibility);
  if (eventSupported) (screen as unknown as EventTarget).addEventListener("change", later);
  syncPoll();

  let off: (() => void) | undefined;
  if (tauri) {
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      void Promise.all([w.onMoved(later), w.onScaleChanged(later)]).then((uns) => {
        if (stopped) uns.forEach((u) => u());
        else off = () => uns.forEach((u) => u());
      });
    });
  }
  return () => {
    stopped = true;
    window.removeEventListener("focus", later);
    document.removeEventListener("visibilitychange", onVisibility);
    if (eventSupported) (screen as unknown as EventTarget).removeEventListener("change", later);
    window.clearTimeout(debounce);
    if (poll) window.clearInterval(poll);
    off?.();
  };
}
