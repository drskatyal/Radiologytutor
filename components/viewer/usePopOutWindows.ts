"use client";

// Web "pop out to a new window": the browser's version of the desktop's
// viewer-window-per-monitor. A popped-out window gets the opened files from
// its opener (structured-cloned `File`s; nothing is uploaded), shows the
// chosen series, and links scroll (by patient position) and window / level
// with every other window of this study over a BroadcastChannel. Browsers
// cannot place a window on a given monitor; the reader drags it there.
//
// Messages are the viewer core's `WindowSyncMessage` (same as desktop).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isWindowSyncMessage,
  nearestIndex,
  positionsAlong,
  sliceNormalOf,
  type LocalSeries,
  type WindowSyncMessage,
} from "@flowrad/viewer-core";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { ViewerEvent } from "@/lib/types";

const CHANNEL = "flowrad-web-viewer-sync";

/** This window's id: "main", or the pop-out's id from `?popout=`. */
function readWindowId(): string {
  if (typeof window === "undefined") return "main";
  return new URLSearchParams(window.location.search).get("popout") || "main";
}

interface Handoff {
  files: File[];
  seriesUid: string;
}

/** Slice positions of a series along its normal (per image; frames of one instance share it). */
function geometryOf(series: LocalSeries | null): { normal: [number, number, number]; positions: number[] } | null {
  if (!series) return null;
  const normal = sliceNormalOf(series.instances.find((i) => i.imageOrientationPatient)?.imageOrientationPatient);
  if (!normal) return null;
  const ipps = series.instances.flatMap((i) => Array.from({ length: Math.max(1, i.numberOfFrames ?? 1) }, () => i.imagePositionPatient as [number, number, number] | undefined));
  const positions = positionsAlong(ipps, normal);
  return positions.every(Number.isFinite) ? { normal, positions } : null;
}

export function usePopOutWindows({
  files,
  series,
  studyUid,
  controls,
  onHandoff,
}: {
  /** The files this window opened (handed to pop-outs). */
  files: File[] | null;
  series: LocalSeries | null;
  studyUid: string | null;
  controls: React.MutableRefObject<CornerstoneControls | null>;
  /** Pop-out window: open these files and show this series. */
  onHandoff: (handoff: Handoff) => void;
}) {
  const windowId = useMemo(readWindowId, []);
  const isPopOut = windowId !== "main";
  const [linked, setLinked] = useState(true);
  const [others, setOthers] = useState(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const pending = useRef(new Map<string, Handoff>());
  const last = useRef<Record<string, string>>({});
  const live = useRef({ series, studyUid, linked });
  live.current = { series, studyUid, linked };
  const geometry = useMemo(() => geometryOf(series), [series]);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  useEffect(() => {
    if (typeof BroadcastChannel !== "function") return;
    const ch = new BroadcastChannel(CHANNEL);
    channel.current = ch;
    ch.onmessage = (e) => {
      const m = e.data as WindowSyncMessage;
      if (!isWindowSyncMessage(m) || m.from === windowId) return;
      if (m.kind === "window-state") setOthers((n) => Math.max(n, 1));
      if (m.kind === "closed") setOthers((n) => Math.max(0, n - 1));
      if (m.kind === "links") setLinked(m.scroll);
      const c = controls.current;
      const { linked: on, studyUid: study } = live.current;
      if (!c || !on) return;
      if (m.kind === "slice" && m.frame === study) {
        const g = geometryRef.current;
        if (!g || Math.abs(g.normal[0] * m.normal[0] + g.normal[1] * m.normal[1] + g.normal[2] * m.normal[2]) < 0.95) return;
        const index = nearestIndex(g.positions, m.z);
        last.current.slice = `${study}|${Math.round(g.positions[index] * 10)}`;
        c.applyEvent({ t: 0, type: "slice", index });
      } else if (m.kind === "voi") {
        last.current.voi = `${Math.round(m.ww)}|${Math.round(m.wc)}`;
        c.applyEvent({ t: 0, type: "voi", ww: m.ww, wc: m.wc });
      }
    };
    const bye = () => ch.postMessage({ kind: "closed", from: windowId });
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      ch.close();
      channel.current = null;
    };
  }, [windowId, controls]);

  // Say hello (so the opener knows a pop-out is live and shows the link toggle).
  useEffect(() => {
    if (!isPopOut || !series) return;
    channel.current?.postMessage({ kind: "window-state", from: windowId, rows: 1, cols: 1, cells: [series.seriesInstanceUID], studyKey: studyUid ?? undefined });
  }, [isPopOut, series, studyUid, windowId]);

  // Pop-out: ask the opener for the files.
  useEffect(() => {
    if (!isPopOut) return;
    const opener = window.opener as Window | null;
    if (!opener) return;
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { kind?: string; id?: string; handoff?: Handoff } | null;
      if (e.origin !== window.location.origin || m?.kind !== "flowrad-handoff" || m.id !== windowId || !m.handoff) return;
      window.removeEventListener("message", onMessage);
      onHandoff(m.handoff);
    };
    window.addEventListener("message", onMessage);
    opener.postMessage({ kind: "flowrad-handoff-request", id: windowId }, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per pop-out
  }, [isPopOut, windowId]);

  // Opener: answer pop-outs asking for their files.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const ask = e.data as { kind?: string; id?: string } | null;
      if (e.origin !== window.location.origin || ask?.kind !== "flowrad-handoff-request" || !ask.id) return;
      const handoff = pending.current.get(ask.id);
      if (!handoff) return;
      pending.current.delete(ask.id);
      (e.source as Window | null)?.postMessage({ kind: "flowrad-handoff", id: ask.id, handoff }, window.location.origin);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /** Open the current series in a new browser window. False when pop-ups are blocked. */
  const popOut = useCallback((): boolean => {
    if (!files?.length || !series) return false;
    const id = `w${Date.now().toString(36)}`;
    pending.current.set(id, { files, seriesUid: series.seriesInstanceUID });
    const url = new URL(window.location.href);
    url.search = `?popout=${id}`;
    const w = window.open(url.toString(), id, "popup,width=1200,height=820");
    if (!w) {
      pending.current.delete(id);
      return false;
    }
    setOthers((n) => n + 1);
    return true;
  }, [files, series]);

  /** Viewer events of this window → the others (scroll by patient position, W/L). */
  const onViewerEvent = useCallback(
    (e: ViewerEvent) => {
      const ch = channel.current;
      const { linked: on, studyUid: study } = live.current;
      if (!ch || !on || !study) return;
      if (e.type === "slice") {
        const g = geometryRef.current;
        const z = g?.positions[e.index];
        if (!g || z == null) return;
        const key = `${study}|${Math.round(z * 10)}`;
        if (key === last.current.slice) return;
        last.current.slice = key;
        ch.postMessage({ kind: "slice", from: windowId, frame: study, normal: g.normal, z } satisfies WindowSyncMessage);
      } else if (e.type === "voi") {
        const key = `${Math.round(e.ww)}|${Math.round(e.wc)}`;
        if (key === last.current.voi) return;
        last.current.voi = key;
        ch.postMessage({ kind: "voi", from: windowId, ww: e.ww, wc: e.wc } satisfies WindowSyncMessage);
      }
    },
    [windowId]
  );

  const toggleLinked = useCallback(() => {
    setLinked((on) => {
      channel.current?.postMessage({ kind: "links", from: windowId, scroll: !on, voi: !on, zoom: false, referenceLines: false } satisfies WindowSyncMessage);
      return !on;
    });
  }, [windowId]);

  return { isPopOut, popOut, onViewerEvent, linked, toggleLinked, hasOtherWindows: isPopOut || others > 0 };
}
