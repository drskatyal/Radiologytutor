// ============================================================================
// lib/pacsbinClient.ts
//
// Adapter for Pacsbin's embed client + its postMessage channel. Pacsbin
// controls are URL-param-only for SETTING state (see pacsbinUrl.ts). For
// READING state as the tutor navigates natively, the only possible channel is
// postMessage from the iframe — IF Pacsbin emits it.
//
// Documented embed client API (from Pacsbin docs / embedding gist):
//   new PacsbinClient(); pbClient.setTool(sel, tool);
//   pbClient.toggleAnnotations(sel, bool); pbClient.noPageScrollWheel({...});
// No state-read / event API is documented. So `subscribeState` listens to ALL
// messages from the Pacsbin origin and best-effort normalises them to our
// Viewport — and the author "signal monitor" surfaces the raw shape so we can
// confirm empirically on a real case what (if anything) Pacsbin emits.
//
// Everything Pacsbin-specific stays here; swap for another viewer freely.
// ============================================================================

"use client";

import type { Viewport } from "./types";

export type PacsbinTool =
  | "wwwc-tool"
  | "zoom-tool"
  | "pan-tool"
  | "scroll-tool"
  | "length-tool"
  | "arrow-tool";

interface PacsbinClientLike {
  setTool: (selector: string, tool: string) => void;
  toggleAnnotations: (selector: string, visible: boolean) => void;
  noPageScrollWheel: (opts: { elementSelector: string }) => void;
}

declare global {
  interface Window {
    PacsbinClient?: new () => PacsbinClientLike;
  }
}

/** Load the Pacsbin embed client script once (URL configurable). Resolves
 * null if no script URL is configured or it fails to load — callers degrade
 * gracefully (we can still drive via URL params). */
let scriptPromise: Promise<PacsbinClientLike | null> | null = null;

export function loadPacsbinClient(scriptUrl?: string): Promise<PacsbinClientLike | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve) => {
    if (window.PacsbinClient) {
      resolve(new window.PacsbinClient());
      return;
    }
    if (!scriptUrl) {
      resolve(null);
      return;
    }
    const s = document.createElement("script");
    s.src = scriptUrl;
    s.async = true;
    s.onload = () => resolve(window.PacsbinClient ? new window.PacsbinClient() : null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export interface StateMessage {
  /** Raw message data exactly as Pacsbin posted it (for the signal monitor). */
  raw: unknown;
  /** Best-effort viewport extracted from the message, if recognisable. */
  viewport?: Viewport;
}

/**
 * Subscribe to viewport state from the Pacsbin iframe via postMessage.
 * Returns an unsubscribe function. We accept messages whose origin matches the
 * iframe's origin and try to normalise common field shapes; unknown shapes are
 * still forwarded as `raw` so the author monitor can reveal the real format.
 */
export function subscribeState(
  iframe: HTMLIFrameElement,
  cb: (msg: StateMessage) => void
): () => void {
  let iframeOrigin = "";
  try {
    iframeOrigin = new URL(iframe.src).origin;
  } catch {
    /* ignore */
  }

  const handler = (event: MessageEvent) => {
    // Only trust messages from the Pacsbin iframe's origin + window.
    if (iframeOrigin && event.origin !== iframeOrigin) return;
    if (iframe.contentWindow && event.source !== iframe.contentWindow) return;

    cb({ raw: event.data, viewport: normaliseViewport(event.data) });
  };

  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

/** Heuristic normaliser: pull a Viewport out of an unknown message body.
 * Handles both our `s:1` style and likely camelCase fields. Returns undefined
 * when the message clearly isn't viewport state. */
export function normaliseViewport(data: unknown): Viewport | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, any>;

  // Some embeds wrap payloads as { type, payload } — unwrap.
  const body: Record<string, any> =
    d.payload && typeof d.payload === "object" ? d.payload : d;

  const series = body["s:1"] ?? body.series ?? body.seriesId ?? body.s1;
  const image = body["i:1"] ?? body.image ?? body.imageId ?? body.i1;
  if (series == null && image == null) return undefined;

  const numOr = (...vals: any[]) => {
    for (const v of vals) {
      const n = Number(v);
      if (v != null && Number.isFinite(n)) return n;
    }
    return undefined;
  };

  return {
    layout: String(body.layout ?? "1x1"),
    s1: series != null ? String(series) : "",
    i1: image != null ? String(image) : "",
    ww1: numOr(body["ww:1"], body.ww, body.windowWidth, body.ww1),
    wc1: numOr(body["wc:1"], body.wc, body.windowCenter, body.wc1),
    scale1: numOr(body["scale:1"], body.scale, body.zoom, body.scale1),
    translation1:
      body["translation:1"] ?? body.translation ?? body.pan ?? body.translation1,
  };
}
