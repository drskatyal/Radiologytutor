"use client";

// Text-box annotations on the web stack viewer, saved in this browser
// (IndexedDB) per series and re-attached to their image by SOP Instance UID.
// Boxes are anchored in image pixels (column, row) and follow zoom, pan,
// rotation and flips through Cornerstone's image ↔ world ↔ canvas mapping.
// Nothing is uploaded and the DICOM files are never changed. Not a DICOM
// presentation state: other viewers do not see these
// (docs/RECON_AND_ANNOTATIONS.md).
//
// With the Text box tool on: click to place and type (Ctrl/⌘+Enter, Tab or a
// click elsewhere to finish, Esc to cancel); drag a box to move it,
// double-click to edit, Delete removes the selected box.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  annotationRecord,
  imageStorageKey,
  MAX_ANNOTATION_TEXT,
  parseAnnotationRecord,
  seriesStorageKey,
  textBoxLines,
  type StoredAnnotation,
} from "@flowrad/viewer-core/annotationPersistence";
import { idbDelete, idbGet, idbSet } from "@/lib/idbStore";

/* eslint-disable @typescript-eslint/no-explicit-any -- Cornerstone modules are loaded lazily and untyped here. */

export interface TextBoxLayerHandle {
  /** The viewport's pixels + its annotation layer + text boxes, for an annotated PNG. */
  composite: () => Promise<HTMLCanvasElement | null>;
  /** Boxes on the image on screen. */
  count: () => number;
}

interface Box {
  id: string;
  imageKey: string;
  col: number;
  row: number;
  text: string;
}

const BOX = { charPx: 6.6, linePx: 15, pad: 6, offset: 8, maxChars: 36 };

function boxSize(text: string) {
  const lines = textBoxLines(text || "…", BOX.maxChars);
  return { lines, w: Math.max(4, ...lines.map((l) => l.length)) * BOX.charPx + BOX.pad * 2, h: lines.length * BOX.linePx + BOX.pad * 2 };
}

let seq = 0;
const newId = () => `wt-${Date.now().toString(36)}-${(seq += 1)}`;

function frameOf(imageId: string): number {
  const m = /[?&]frame=(\d+)/.exec(imageId);
  return m ? Math.max(0, Number(m[1]) - 1) : 0;
}

export const WebTextBoxLayer = forwardRef<TextBoxLayerHandle, { element: HTMLDivElement | null; active: boolean; hidden?: boolean }>(function WebTextBoxLayer(
  { element, active, hidden = false },
  ref
) {
  const [core, setCore] = useState<any>(null);
  const [, setTick] = useState(0);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [seriesKey, setSeriesKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const loadedKey = useRef<string | null>(null);
  const savedJson = useRef("[]");

  useEffect(() => {
    let live = true;
    void import("@cornerstonejs/core").then((m) => live && setCore(m));
    return () => {
      live = false;
    };
  }, []);

  const vp = useCallback((): any => (core && element ? core.getEnabledElement(element)?.viewport ?? null : null), [core, element]);

  const current = useCallback((): { imageId: string; imageKey: string; seriesUid: string | null } | null => {
    const v = vp();
    const imageId: string | undefined = v?.getCurrentImageId?.();
    if (!imageId || !core) return null;
    const sop = core.metaData.get("sopCommonModule", imageId)?.sopInstanceUID ?? core.metaData.get("generalImageModule", imageId)?.sopInstanceUID;
    const series = core.metaData.get("generalSeriesModule", imageId)?.seriesInstanceUID ?? null;
    return { imageId, imageKey: imageStorageKey(String(sop ?? imageId), frameOf(imageId)), seriesUid: series };
  }, [core, vp]);

  // Redraw with the image / camera; follow series changes.
  useEffect(() => {
    if (!core || !element) return;
    const ev = core.Enums.Events.IMAGE_RENDERED;
    const bump = () => {
      setTick((t) => t + 1);
      const c = current();
      const key = c?.seriesUid ? seriesStorageKey(c.seriesUid) : null;
      setSeriesKey((k) => (k === key ? k : key));
    };
    element.addEventListener(ev, bump);
    bump();
    return () => element.removeEventListener(ev, bump);
  }, [core, element, current]);

  // Load this series' boxes from IndexedDB.
  useEffect(() => {
    if (!seriesKey) return;
    let live = true;
    loadedKey.current = null;
    setBoxes([]);
    void idbGet<unknown>("annotations", seriesKey).then((raw) => {
      if (!live) return;
      const items = parseAnnotationRecord(raw, seriesKey).filter((a) => a.tool === "TextBox" && a.imageKey);
      const list = items.map((a) => ({ id: a.id, imageKey: a.imageKey!, col: a.points[0][0], row: a.points[0][1], text: a.label ?? "" }));
      savedJson.current = JSON.stringify(list);
      loadedKey.current = seriesKey;
      setBoxes(list);
    });
    return () => {
      live = false;
    };
  }, [seriesKey]);

  // Save (debounced) once loaded.
  useEffect(() => {
    if (!seriesKey || loadedKey.current !== seriesKey) return;
    const json = JSON.stringify(boxes);
    if (json === savedJson.current) return;
    const key = seriesKey;
    const t = window.setTimeout(() => {
      savedJson.current = json;
      const items: StoredAnnotation[] = boxes.filter((b) => b.text).map((b) => ({ id: b.id, tool: "TextBox", imageIndex: 0, points: [[b.col, b.row]], label: b.text, imageKey: b.imageKey }));
      void (items.length ? idbSet("annotations", key, annotationRecord(key, items)) : idbDelete("annotations", key));
    }, 400);
    return () => window.clearTimeout(t);
  }, [boxes, seriesKey]);

  const toCanvas = (b: Box, imageId: string): [number, number] | null => {
    const v = vp();
    try {
      const world = core.utilities.imageToWorldCoords(imageId, [b.col, b.row]);
      return v.worldToCanvas(world) as [number, number];
    } catch {
      return null;
    }
  };
  const toImage = (x: number, y: number, imageId: string): [number, number] | null => {
    const v = vp();
    try {
      const world = v.canvasToWorld([x, y]);
      return core.utilities.worldToImageCoords(imageId, world) as [number, number];
    } catch {
      return null;
    }
  };

  const c = core && element ? current() : null;
  const onImage = c ? boxes.filter((b) => b.imageKey === c.imageKey) : [];

  useImperativeHandle(
    ref,
    () => ({
      count: () => onImage.length,
      composite: async () => {
        const canvas = element?.querySelector("canvas");
        if (!element || !canvas || !c) return null;
        const r = element.getBoundingClientRect();
        const k = canvas.width / Math.max(1, r.width);
        const out = document.createElement("canvas");
        out.width = canvas.width;
        out.height = canvas.height;
        const ctx = out.getContext("2d")!;
        ctx.drawImage(canvas, 0, 0);
        // Cornerstone's own annotation layer (measurements, arrows).
        const svg = element.querySelector("svg");
        if (svg && svg.childElementCount) {
          const clone = svg.cloneNode(true) as SVGSVGElement;
          clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
          clone.setAttribute("width", String(out.width));
          clone.setAttribute("height", String(out.height));
          clone.setAttribute("viewBox", `0 0 ${r.width} ${r.height}`);
          const img = new Image();
          await new Promise<void>((res) => {
            img.onload = () => res();
            img.onerror = () => res();
            img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
          });
          if (img.naturalWidth) ctx.drawImage(img, 0, 0, out.width, out.height);
        }
        ctx.scale(k, k);
        ctx.font = "11px Inter, -apple-system, 'Segoe UI', system-ui, sans-serif";
        ctx.textBaseline = "top";
        for (const b of onImage) {
          const at = toCanvas(b, c.imageId);
          if (!at) continue;
          const { lines, w, h } = boxSize(b.text);
          const [x, y] = [at[0] + BOX.offset, at[1] + BOX.offset];
          ctx.strokeStyle = "rgb(250 204 21)";
          ctx.fillStyle = "rgb(250 204 21)";
          ctx.beginPath();
          ctx.arc(at[0], at[1], 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(at[0], at[1]);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.fillStyle = "rgba(0,0,0,0.65)";
          ctx.fillRect(x, y, w, h);
          ctx.strokeRect(x, y, w, h);
          ctx.fillStyle = "#fff";
          lines.forEach((line, i) => ctx.fillText(line, x + BOX.pad, y + BOX.pad + 2 + i * BOX.linePx));
        }
        return out;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [element, c?.imageKey, onImage]
  );

  // Delete / Escape while the tool is on.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        e.stopPropagation();
        setBoxes((bs) => bs.filter((b) => b.id !== selected));
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, selected]);

  if (!c || !element) return null;
  const local = (e: React.PointerEvent): [number, number] => {
    const r = element.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const editingBox = editing ? boxes.find((b) => b.id === editing) : null;
  const editAt = editingBox ? toCanvas(editingBox, c.imageId) : null;

  return (
    <div
      className={active ? "absolute inset-0 z-20 cursor-text" : "pointer-events-none absolute inset-0 z-20"}
      data-testid="web-text-boxes"
      onPointerDown={(e) => {
        if (!active || e.button !== 0) return;
        e.stopPropagation();
        // Keep the browser from moving focus on mousedown (it would blur the new editor).
        e.preventDefault();
        const [x, y] = local(e);
        const hit = [...onImage].reverse().find((b) => {
          const at = toCanvas(b, c.imageId);
          if (!at) return false;
          const { w, h } = boxSize(b.text);
          return x >= at[0] + BOX.offset - 4 && x <= at[0] + BOX.offset + w + 4 && y >= at[1] + BOX.offset - 4 && y <= at[1] + BOX.offset + h + 4;
        });
        if (hit) {
          const at = toCanvas(hit, c.imageId)!;
          setSelected(hit.id);
          if (e.detail >= 2) return setEditing(hit.id);
          drag.current = { id: hit.id, dx: x - at[0], dy: y - at[1], moved: false };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          return;
        }
        const p = toImage(x, y, c.imageId);
        if (!p) return;
        const box: Box = { id: newId(), imageKey: c.imageKey, col: p[0], row: p[1], text: "" };
        setBoxes((bs) => [...bs, box]);
        setSelected(box.id);
        setEditing(box.id);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const [x, y] = local(e);
        const p = toImage(x - d.dx, y - d.dy, c.imageId);
        if (!p) return;
        d.moved = true;
        setBoxes((bs) => bs.map((b) => (b.id === d.id ? { ...b, col: p[0], row: p[1] } : b)));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {!hidden && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          {onImage.map((b) => {
            const at = toCanvas(b, c.imageId);
            if (!at || b.id === editing) return null;
            const { lines, w, h } = boxSize(b.text);
            const [x, y] = [at[0] + BOX.offset, at[1] + BOX.offset];
            const stroke = b.id === selected && active ? "rgb(var(--accent))" : "rgb(250 204 21)";
            return (
              <g key={b.id} data-text-box>
                <circle cx={at[0]} cy={at[1]} r={2.5} fill={stroke} />
                <line x1={at[0]} y1={at[1]} x2={x} y2={y} stroke={stroke} strokeWidth={1.5} />
                <rect x={x} y={y} width={w} height={h} rx={3} fill="rgb(0 0 0 / 0.65)" stroke={stroke} />
                <text x={x + BOX.pad} y={y + BOX.pad + 11} className="fill-white text-[11px]">
                  {lines.map((line, i) => (
                    <tspan key={i} x={x + BOX.pad} dy={i === 0 ? 0 : BOX.linePx}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {editingBox && editAt && (
        <TextEditor
          at={editAt}
          initial={editingBox.text}
          onDone={(text) => {
            setEditing(null);
            setBoxes((bs) => (text ? bs.map((b) => (b.id === editingBox.id ? { ...b, text } : b)) : bs.filter((b) => b.id !== editingBox.id)));
          }}
        />
      )}
    </div>
  );
});

function TextEditor({ at, initial, onDone }: { at: [number, number]; initial: string; onDone: (text: string) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const opened = useRef(performance.now());
  useEffect(() => {
    const t = window.setTimeout(() => box.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);
  const finish = (text: string) => {
    if (done.current) return;
    done.current = true;
    onDone(text);
  };
  return (
    <textarea
      ref={box}
      autoFocus
      aria-label="Text box"
      value={value}
      rows={3}
      maxLength={MAX_ANNOTATION_TEXT}
      placeholder="Text (Ctrl+Enter to finish)"
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if ((e.key === "Enter" && (e.ctrlKey || e.metaKey)) || e.key === "Tab") {
          e.preventDefault();
          finish(value.trim());
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(initial);
        }
      }}
      onBlur={() => {
        // The click that opened the editor can blur it a moment later: stay open.
        if (performance.now() - opened.current < 300) return void box.current?.focus();
        finish(value.trim());
      }}
      className="absolute z-40 w-60 resize-none rounded-md border border-strong bg-elevated px-2 py-1 text-xs text-primary shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
      // Dynamic position at the box's anchor.
      style={{ left: at[0] + 8, top: at[1] + 8 }}
    />
  );
}
