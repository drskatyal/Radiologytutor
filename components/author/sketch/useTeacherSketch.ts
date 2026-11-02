"use client";

// State for the Recording Studio's teacher sketch layer.
//
// One source of truth for what is on the image:
//   • LIVE — the teacher's edits fold through an undo/redo history. Every
//     applied op is also sent to the recorder (`onEvent`), so while a take is
//     running the strokes land on the same clock as the narration.
//   • REPLAY — the replay engine hands ops back (`replayOp`); they fold into a
//     separate list stamped with wall time so pen strokes draw back at the
//     speed they were drawn. Live edits are paused while replay owns the layer.
//
// The live sketch survives a reload (sessionStorage per case) — the anchors
// are image-space, so it lands back on the same pixels at any zoom.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  anchorPoint,
  commitSketchOp,
  defaultMarkerLabel,
  EMPTY_HISTORY,
  imageRefFrom,
  nextMarkerNumber,
  redoSketch,
  undoSketch,
  cleanSketchItem,
  type SketchHistory,
  type TeacherSketchTool,
} from "@/lib/teacherSketch";
import type { SketchFrame } from "@/lib/sketchProjection";
import type { TeacherSketchItem, TeacherSketchOp, ViewerEvent } from "@/lib/types";

export interface ReplayedItem {
  item: TeacherSketchItem;
  /** performance.now() when the stroke began drawing back. */
  bornAt: number;
}

export interface UseTeacherSketch {
  tool: TeacherSketchTool;
  setTool: (tool: TeacherSketchTool) => void;
  /** Items the layer should draw (live, or the replay fold). */
  items: TeacherSketchItem[];
  /** Replay stamps for progressive draw-back; empty while live. */
  replayed: ReplayedItem[];
  replaying: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** The marker whose label popover is open. */
  labelling: TeacherSketchItem | null;
  commit: (op: TeacherSketchOp) => void;
  undo: () => void;
  redo: () => void;
  clearAll: () => void;
  /** Drop a numbered marker at an image fraction on the frame's image. */
  dropMarker: (frame: SketchFrame, xPct: number, yPct: number) => TeacherSketchItem | null;
  setLabel: (id: string, text: string) => void;
  closeLabel: () => void;
  /** Replay sink: fold one op from the recorded timeline. */
  replayOp: (op: TeacherSketchOp) => void;
  /** Leave replay and show the live sketch again. */
  endReplay: () => void;
  /** Snapshot op for the first event of a take (what was on screen at t=0). */
  snapshot: () => TeacherSketchOp;
  newId: (kind: string) => string;
}

const STORE_PREFIX = "flowrad:studio-sketch:";

function readStore(key: string): TeacherSketchItem[] {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(cleanSketchItem).filter((i): i is TeacherSketchItem => !!i) : [];
  } catch {
    return [];
  }
}

function writeStore(key: string, items: TeacherSketchItem[]) {
  try {
    if (items.length) window.sessionStorage.setItem(key, JSON.stringify(items));
    else window.sessionStorage.removeItem(key);
  } catch {
    /* private mode / quota — the take still records */
  }
}

export function useTeacherSketch(opts: {
  caseId: string;
  onEvent: (e: ViewerEvent) => void;
}): UseTeacherSketch {
  const { caseId, onEvent } = opts;
  const storeKey = `${STORE_PREFIX}${caseId}`;
  const [history, setHistory] = useState<SketchHistory>(EMPTY_HISTORY);
  const historyRef = useRef(history);
  historyRef.current = history;
  const [tool, setTool] = useState<TeacherSketchTool>("select");
  const [labellingId, setLabellingId] = useState<string | null>(null);
  const [replayed, setReplayed] = useState<ReplayedItem[] | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const seq = useRef(0);

  // Restore after a reload.
  useEffect(() => {
    const items = readStore(storeKey);
    if (items.length) setHistory({ items, undo: [], redo: [] });
  }, [storeKey]);

  useEffect(() => {
    writeStore(storeKey, history.items);
  }, [storeKey, history.items]);

  const newId = useCallback((kind: string) => {
    seq.current += 1;
    return `${kind}-${Date.now().toString(36)}-${seq.current.toString(36)}`;
  }, []);

  const emit = useCallback((op: TeacherSketchOp) => {
    onEventRef.current({ type: "sketch", ...op } as ViewerEvent);
  }, []);

  const run = useCallback(
    (step: (h: SketchHistory) => { history: SketchHistory; applied: TeacherSketchOp | null }) => {
      if (replayed) return;
      const { history: next, applied } = step(historyRef.current);
      if (!applied) return;
      historyRef.current = next;
      setHistory(next);
      emit(applied);
    },
    [emit, replayed]
  );

  const commit = useCallback((op: TeacherSketchOp) => run((h) => commitSketchOp(h, op)), [run]);
  const undo = useCallback(() => run(undoSketch), [run]);
  const redo = useCallback(() => run(redoSketch), [run]);
  const clearAll = useCallback(() => {
    if (historyRef.current.items.length) commit({ op: "reset", items: [] });
    setLabellingId(null);
  }, [commit]);

  const dropMarker = useCallback(
    (frame: SketchFrame, xPct: number, yPct: number) => {
      if (replayed) return null;
      if (xPct < 0 || xPct > 1 || yPct < 0 || yPct > 1) return null;
      const number = nextMarkerNumber(historyRef.current.items);
      const item: TeacherSketchItem = {
        id: newId("marker"),
        kind: "marker",
        image: imageRefFrom(frame.image, frame.sliceIndex),
        points: [anchorPoint(xPct, yPct, frame.image)],
        number,
        text: defaultMarkerLabel(number),
      };
      commit({ op: "add", item });
      setLabellingId(item.id);
      return item;
    },
    [commit, newId, replayed]
  );

  const setLabel = useCallback(
    (id: string, text: string) => {
      const clean = text.trim();
      const item = historyRef.current.items.find((i) => i.id === id);
      if (item && clean && clean !== item.text) commit({ op: "label", id, text: clean });
      setLabellingId(null);
    },
    [commit]
  );

  const closeLabel = useCallback(() => setLabellingId(null), []);

  const replayOp = useCallback((op: TeacherSketchOp) => {
    const now = performance.now();
    setLabellingId(null);
    setReplayed((prev) => {
      const list = prev ?? [];
      switch (op.op) {
        case "add":
          return [...list.filter((r) => r.item.id !== op.item.id), { item: op.item, bornAt: now }];
        case "remove":
          return list.filter((r) => r.item.id !== op.id);
        case "label":
          return list.map((r) => (r.item.id === op.id ? { ...r, item: { ...r.item, text: op.text } } : r));
        case "reset":
          return op.items.map((item) => ({ item, bornAt: now - (item.drawMs ?? 0) }));
        default:
          return list;
      }
    });
  }, []);

  const endReplay = useCallback(() => setReplayed(null), []);

  const snapshot = useCallback((): TeacherSketchOp => ({ op: "reset", items: [...historyRef.current.items] }), []);

  const items = useMemo(
    () => (replayed ? replayed.map((r) => r.item) : history.items),
    [replayed, history.items]
  );

  const labelling = useMemo(
    () => (labellingId ? history.items.find((i) => i.id === labellingId) ?? null : null),
    [labellingId, history.items]
  );

  return {
    tool,
    setTool,
    items,
    replayed: replayed ?? [],
    replaying: replayed != null,
    canUndo: !replayed && history.undo.length > 0,
    canRedo: !replayed && history.redo.length > 0,
    labelling,
    commit,
    undo,
    redo,
    clearAll,
    dropMarker,
    setLabel,
    closeLabel,
    replayOp,
    endReplay,
    snapshot,
    newId,
  };
}

