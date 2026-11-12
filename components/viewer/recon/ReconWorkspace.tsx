"use client";

// Multi-oblique, slab and curved / cross-curved MPR on one volume. Shared by
// the web viewer and the desktop app; the platform supplies a ReconSource.
//
//   Oblique  three mutually perpendicular planes with a linked 3D crosshair.
//            Click / drag sets the crosshair (the other planes follow); drag a
//            line's round handle to turn the other two planes about this
//            pane's normal (repeat in a second pane for double oblique).
//            Wheel scrolls the pane (Shift ×5), Ctrl/⌘+wheel zooms, right-drag
//            sets window / level, middle-drag pans. Slab: thin, MIP, MinIP or
//            average, any thickness.
//   Curved   place centreline points on any plane (scroll between clicks to
//            follow a vessel out of plane; points can be added from any
//            pane). Drag a point to move it, Shift+click inserts into the
//            nearest segment, double-click deletes, Backspace removes the last.
//            The straightened CPR, a cross-section perpendicular to the curve
//            and a strip of neighbouring sections update as you edit; click
//            the CPR to move the section (and the 3D crosshair) along it.
//
// All geometry is in patient millimetres (packages/viewer-core/src/recon):
// orientation letters, lengths and scale bars come from the volume's DICOM
// orientation and spacing, anisotropic and oblique acquisitions included.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Crosshair, Download, Hand, RotateCcw, Ruler, Spline, SunMedium, ZoomIn, ZoomOut } from "lucide-react";
import {
  crossSectionGrid,
  crossSectionStations,
  crosshairLines,
  curveFrames,
  directionLetters,
  edgeLetters,
  finestSpacing,
  frameAt,
  initialOblique,
  insertPoint,
  movePoint,
  norm,
  paneGrid,
  paneNormal,
  paneToPatient,
  patientToPane,
  planeName,
  polylineLengthMm,
  removePoint,
  rotateOthers,
  scale,
  scrollPane,
  straightenedGrid,
  sub,
  cprPixelToPatient,
  type CurveFrames,
  type ObliqueState,
  type PaneGrid,
  type PaneView,
  type PlaneGrid,
  type Projection,
  type SampleGrid,
  type Vec3,
} from "@flowrad/viewer-core/recon";
import { BURNED_IN_WARNING } from "@flowrad/viewer-core/annotationPersistence";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/components/ui/cn";
import { ReconPane, usePaneSize, useReconImage, type PanePointer } from "./ReconPane";
import type { ReconSource } from "./types";

type SlabMode = Projection | "off";
type Tool = "crosshair" | "wl" | "pan" | "measure" | "curve";

const PANE_COLORS = ["warning", "info", "success"] as const;
const strokeOf = (i: number) => ["stroke-warning", "stroke-info", "stroke-success"][i];
const fillOf = (i: number) => ["fill-warning", "fill-info", "fill-success"][i];
const textOf = (i: number) => ["text-warning", "text-info", "text-success"][i];

interface Measure {
  id: number;
  pane: string;
  /** Pane grid key the measurement belongs to (shown only on that exact plane). */
  planeKey: string;
  a: [number, number];
  b: [number, number];
  mm: number;
  /** CPR lengths are along the straightened image: exact along the curve, approximate across it. */
  approx?: boolean;
}

const r6 = (n: number) => Math.round(n * 1e4) / 1e4;
function gridKey(grid: SampleGrid | null): string {
  if (!grid) return "";
  if (grid.kind === "plane") {
    return JSON.stringify([grid.origin.map(r6), grid.du.map(r6), grid.dv.map(r6), grid.width, grid.height, grid.slab ? [grid.slab.mode, r6(grid.slab.thicknessMm)] : 0]);
  }
  return JSON.stringify([grid.points.length, grid.points[0]?.map(r6), grid.points[grid.points.length - 1]?.map(r6), grid.up[0]?.map(r6), grid.halfRows, grid.rowStepMm, grid.slab ? [grid.slab.mode, grid.slab.thicknessMm] : 0, grid.points.reduce((s, p) => s + p[0] + 2 * p[1] + 3 * p[2], 0)]);
}

/** Keep the same grid object while its sampling parameters are unchanged (no resample). */
function useStableGrid<T extends SampleGrid>(grid: T | null): T | null {
  const ref = useRef<{ key: string; grid: T | null }>({ key: "", grid: null });
  const key = gridKey(grid);
  if (key !== ref.current.key) ref.current = { key, grid };
  return ref.current.grid;
}

function niceScale(pixelMm: number, widthPx: number): { mm: number; fraction: number } {
  const target = pixelMm * widthPx * 0.18;
  const steps = [1, 2, 5, 10, 20, 50, 100, 200];
  const mm = steps.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), steps[0]);
  return { mm, fraction: mm / (pixelMm * widthPx) };
}

function ScaleBar({ pixelMm, width }: { pixelMm: number; width: number }) {
  const { mm, fraction } = niceScale(pixelMm, width);
  return (
    <div className="absolute bottom-2 right-2 flex flex-col items-end text-[10px] text-white/80 text-halo">
      {/* Dynamic geometry: the bar is `mm` long at this zoom. */}
      <div className="h-1 border-x border-b border-white/80" style={{ width: `${fraction * 100}%`, minWidth: 12 }} />
      <span className="tabular-nums">{mm} mm</span>
    </div>
  );
}

function EdgeLabels({ top, bottom, left, right }: { top: string; bottom: string; left: string; right: string }) {
  const cls = "absolute font-semibold text-warning/90 text-[11px] text-halo";
  return (
    <>
      <span className={cn(cls, "left-1/2 top-1 -translate-x-1/2")}>{top}</span>
      <span className={cn(cls, "bottom-1 left-1/2 -translate-x-1/2")}>{bottom}</span>
      <span className={cn(cls, "left-1 top-1/2 -translate-y-1/2")}>{left}</span>
      <span className={cn(cls, "right-1 top-1/2 -translate-y-1/2")}>{right}</span>
    </>
  );
}

function SlabSelect({ value, onChange, label }: { value: { mode: SlabMode; mm: number }; onChange: (v: { mode: SlabMode; mm: number }) => void; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-secondary">
      <select
        aria-label={`${label}: slab mode`}
        value={value.mode}
        onChange={(e) => onChange({ ...value, mode: e.target.value as SlabMode })}
        className="h-7 rounded-md border border-subtle bg-elevated px-1 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <option value="off">Thin</option>
        <option value="mip">MIP</option>
        <option value="minip">MinIP</option>
        <option value="avg">Average</option>
      </select>
      <input
        type="range"
        min={1}
        max={100}
        step={0.5}
        value={value.mm}
        disabled={value.mode === "off"}
        onChange={(e) => onChange({ ...value, mm: Number(e.target.value) })}
        aria-label={`${label}: slab thickness in millimetres`}
        className="w-20 accent-accent disabled:opacity-40"
      />
      <span className="w-12 tabular-nums text-primary">{value.mode === "off" ? "—" : `${value.mm} mm`}</span>
    </span>
  );
}

const slabText = (s: { mode: SlabMode; mm: number }) => (s.mode === "off" ? null : `${s.mode === "avg" ? "AVG" : s.mode.toUpperCase()} ${s.mm} mm`);
const slabOf = (s: { mode: SlabMode; mm: number }) => (s.mode === "off" ? undefined : { mode: s.mode, thicknessMm: s.mm });

export interface ReconWorkspaceProps {
  source: ReconSource;
  /** Title in the toolbar, e.g. the series description (no patient identifiers). */
  title: string;
  initialMode?: "oblique" | "curved";
  onExit: () => void;
}

export function ReconWorkspace({ source, title, initialMode = "oblique", onExit }: ReconWorkspaceProps) {
  const g = source.geometry;
  const step = finestSpacing(g);
  const extent = Math.max(g.dims[0] * g.spacing[0], g.dims[1] * g.spacing[1], g.dims[2] * g.spacing[2]);
  const [mode, setMode] = useState<"oblique" | "curved">(initialMode);
  const [align, setAlign] = useState<"patient" | "acquisition">("patient");
  const [state, setState] = useState<ObliqueState>(() => initialOblique(g, "patient"));
  const [views, setViews] = useState<PaneView[]>(() => [0, 1, 2].map(() => ({ fovMm: extent * 1.05, pan: [0, 0] as [number, number] })));
  const [win, setWin] = useState<[number, number]>(source.defaultWindow);
  const [invert, setInvert] = useState(false);
  const [slab, setSlab] = useState<{ mode: SlabMode; mm: number }>({ mode: "off", mm: 10 });
  const [tool, setTool] = useState<Tool>(initialMode === "curved" ? "curve" : "crosshair");
  const [active, setActive] = useState("p0");
  const [curve, setCurve] = useState<{ points: Vec3[]; up: Vec3 } | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  const [cprRotation, setCprRotation] = useState(0);
  const [cprHalf, setCprHalf] = useState(30);
  const [cprSlab, setCprSlab] = useState<{ mode: SlabMode; mm: number }>({ mode: "off", mm: 5 });
  const [station, setStation] = useState(0);
  const [csSize, setCsSize] = useState(40);
  const [csSlab, setCsSlab] = useState<{ mode: SlabMode; mm: number }>({ mode: "off", mm: 3 });
  const [stripInterval, setStripInterval] = useState(5);
  const [measures, setMeasures] = useState<Measure[]>([]);
  const [exporting, setExporting] = useState(false);
  const measureSeq = useRef(0);

  const resetAll = useCallback(() => {
    setState(initialOblique(g, align));
    setViews([0, 1, 2].map(() => ({ fovMm: extent * 1.05, pan: [0, 0] as [number, number] })));
    setWin(source.defaultWindow);
    setSlab({ mode: "off", mm: 10 });
  }, [g, align, extent, source.defaultWindow]);

  // ───── oblique panes ─────
  const [ref0, size0] = usePaneSize();
  const [ref1, size1] = usePaneSize();
  const [ref2, size2] = usePaneSize();
  const sizes = [size0, size1, size2];
  const paneRefs = [ref0, ref1, ref2];
  const rawGrids = [0, 1, 2].map((i) => {
    const s = sizes[i];
    return s ? paneGrid(g, state, i, views[i], s.width, s.height, slabOf(slab)) : null;
  });
  const grid0 = useStableGrid<PaneGrid>(rawGrids[0]);
  const grid1 = useStableGrid<PaneGrid>(rawGrids[1]);
  const grid2 = useStableGrid<PaneGrid>(rawGrids[2]);
  const grids = [grid0, grid1, grid2];
  const img0 = useReconImage(source, grid0, "p0");
  const img1 = useReconImage(source, grid1, "p1");
  const img2 = useReconImage(source, grid2, "p2");
  const images = [img0, img1, img2];

  // ───── curved ─────
  const frames: CurveFrames | null = useMemo(() => {
    if (!curve || curve.points.length < 2) return null;
    const approx = polylineLengthMm(curve.points);
    const cprStep = Math.max(step, approx / 2048, 0.2);
    try {
      return curveFrames(curve.points, cprStep, curve.up, cprRotation);
    } catch {
      return null;
    }
  }, [curve, cprRotation, step]);
  useEffect(() => {
    if (frames) setStation((s) => Math.min(Math.max(0, s), frames.lengthMm));
  }, [frames]);
  const [refCpr, sizeCpr] = usePaneSize();
  const [refCs, sizeCs] = usePaneSize();
  const cprGrid = useStableGrid(frames && mode === "curved" ? straightenedGrid(frames, cprHalf, slabOf(cprSlab)) : null);
  const csPixel = sizeCs ? csSize / Math.min(sizeCs.width, sizeCs.height) : 0.25;
  const csGrid = useStableGrid<PlaneGrid & { right: Vec3; down: Vec3; center: Vec3 }>(
    frames && mode === "curved" && sizeCs ? crossSectionGrid(frames, station, csSize, Math.max(csPixel, step / 2), slabOf(csSlab)) : null
  );
  const cprImg = useReconImage(source, cprGrid, "cpr");
  const csImg = useReconImage(source, csGrid, "cs");
  const stations = frames ? crossSectionStations(frames, station, 5, stripInterval) : [];

  // ───── input ─────
  const drag = useRef<
    | { kind: "center"; pane: number }
    | { kind: "rotate"; pane: number; last: number }
    | { kind: "wl"; x: number; y: number; win: [number, number] }
    | { kind: "pan"; pane: number; x: number; y: number; pan: [number, number] }
    | { kind: "measure"; pane: string; planeKey: string; a: [number, number]; pixelMm: number; approx?: boolean; toPatient?: (x: number, y: number) => Vec3 }
    | { kind: "point"; index: number; pane: number }
    | { kind: "scrub" }
    | null
  >(null);
  const [draftMeasure, setDraftMeasure] = useState<Measure | null>(null);

  const startCommon = (p: PanePointer, paneIndex: number | null): boolean => {
    if (p.button === 2 || tool === "wl") {
      drag.current = { kind: "wl", x: p.x, y: p.y, win };
      return true;
    }
    if (p.button === 1 || (tool === "pan" && paneIndex != null)) {
      if (paneIndex == null) return false;
      drag.current = { kind: "pan", pane: paneIndex, x: p.x, y: p.y, pan: views[paneIndex].pan };
      return true;
    }
    return false;
  };

  const moveCommon = (p: PanePointer): boolean => {
    const d = drag.current;
    if (!d) return false;
    if (d.kind === "wl") {
      const k = Math.max(1, d.win[0]) / 200;
      setWin([Math.max(1, d.win[0] + (p.x - d.x) * k), d.win[1] + (p.y - d.y) * k]);
      return true;
    }
    if (d.kind === "pan") {
      const grid = grids[d.pane];
      if (!grid) return true;
      setViews((vs) => vs.map((v, i) => (i === d.pane ? { ...v, pan: [d.pan[0] - (p.x - d.x) * grid.pixelMm, d.pan[1] - (p.y - d.y) * grid.pixelMm] } : v)));
      // Panning moves the grid under the pointer: re-anchor.
      drag.current = { ...d, x: p.x, y: p.y, pan: [d.pan[0] - (p.x - d.x) * grid.pixelMm, d.pan[1] - (p.y - d.y) * grid.pixelMm] };
      return true;
    }
    return false;
  };

  const handleRadius = (grid: PaneGrid) => 0.36 * Math.min(grid.width, grid.height);

  const onObliquePointer = (i: number) => (phase: "down" | "move" | "up", p: PanePointer) => {
    const grid = grids[i];
    if (!grid) return;
    if (phase === "down") {
      if (startCommon(p, i)) return;
      if (p.button !== 0) return;
      if (tool === "measure") {
        drag.current = { kind: "measure", pane: `p${i}`, planeKey: gridKey(grid), a: [p.x, p.y], pixelMm: grid.pixelMm, toPatient: (x, y) => paneToPatient(grid, x, y) };
        return;
      }
      if (tool === "curve") {
        const pts = curve?.points ?? [];
        const hitTol = 8;
        const hit = pts.findIndex((q) => {
          const s = patientToPane(grid, q);
          return Math.abs(s.depthMm) < Math.max(3, slab.mm / 2) && Math.hypot(s.x - p.x, s.y - p.y) <= Math.max(4, hitTol);
        });
        if (hit >= 0 && p.detail >= 2) {
          setCurve((c) => (c ? { ...c, points: removePoint(c.points, hit) } : c));
          setSelectedPoint(null);
          return;
        }
        if (hit >= 0) {
          setSelectedPoint(hit);
          drag.current = { kind: "point", index: hit, pane: i };
          return;
        }
        const q = paneToPatient(grid, p.x, p.y);
        setCurve((c) => {
          if (!c) return { points: [q], up: paneNormal(state.panes[i]) };
          return { ...c, points: p.shift ? insertPoint(c.points, q) : [...c.points, q] };
        });
        setSelectedPoint(null);
        return;
      }
      // Crosshair: a rotation handle, else move the crosshair here.
      const c = patientToPane(grid, state.center);
      const r = handleRadius(grid);
      const tol = Math.max(6, 0.03 * Math.min(grid.width, grid.height));
      for (const line of crosshairLines(state, i)) {
        for (const sgn of [1, -1]) {
          const hx = c.x + line.dir[0] * r * sgn;
          const hy = c.y + line.dir[1] * r * sgn;
          if (Math.hypot(hx - p.x, hy - p.y) <= tol) {
            drag.current = { kind: "rotate", pane: i, last: Math.atan2(p.y - c.y, p.x - c.x) };
            return;
          }
        }
      }
      setState((s) => ({ ...s, center: paneToPatient(grid, p.x, p.y) }));
      drag.current = { kind: "center", pane: i };
      return;
    }
    if (phase === "move") {
      if (moveCommon(p)) return;
      const d = drag.current;
      if (!d) return;
      if (d.kind === "center" && d.pane === i) setState((s) => ({ ...s, center: paneToPatient(grid, p.x, p.y) }));
      else if (d.kind === "rotate" && d.pane === i) {
        const c = patientToPane(grid, state.center);
        const angle = Math.atan2(p.y - c.y, p.x - c.x);
        let delta = angle - d.last;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        drag.current = { ...d, last: angle };
        setState((s) => rotateOthers(s, i, delta));
      } else if (d.kind === "point" && d.pane === i) {
        const q = paneToPatient(grid, p.x, p.y);
        setCurve((cv) => (cv ? { ...cv, points: movePoint(cv.points, d.index, q) } : cv));
      } else if (d.kind === "measure") {
        const b: [number, number] = [p.x, p.y];
        const mm = d.toPatient ? norm(sub(d.toPatient(b[0], b[1]), d.toPatient(d.a[0], d.a[1]))) : Math.hypot(b[0] - d.a[0], b[1] - d.a[1]) * d.pixelMm;
        setDraftMeasure({ id: -1, pane: d.pane, planeKey: d.planeKey, a: d.a, b, mm });
      }
      return;
    }
    // up
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "measure") finishMeasure();
  };

  const finishMeasure = () => {
    setDraftMeasure((m) => {
      if (m && m.mm > 0) {
        measureSeq.current += 1;
        const done = { ...m, id: measureSeq.current };
        setMeasures((ms) => [...ms, done]);
      }
      return null;
    });
  };

  const onObliqueWheel = (i: number) => (deltaY: number, e: { shift: boolean; mod: boolean }) => {
    const dir = Math.sign(deltaY);
    if (!dir) return;
    if (e.mod) {
      setViews((vs) => vs.map((v, j) => (j === i ? { ...v, fovMm: Math.min(extent * 4, Math.max(5, v.fovMm * (dir > 0 ? 1.12 : 1 / 1.12))) } : v)));
      return;
    }
    setState((s) => scrollPane(s, i, dir * step * (e.shift ? 5 : 1)));
  };

  const onCprPointer = (phase: "down" | "move" | "up", p: PanePointer) => {
    if (!frames || !cprGrid) return;
    // Scrub: the section (and the 3D crosshair) follow the pointer along the curve.
    const scrub = () => {
      setStation(Math.min(frames.lengthMm, Math.max(0, p.x * frames.stepMm)));
      setState((st) => ({ ...st, center: cprPixelToPatient(frames, cprGrid, p.x, Math.min(cprGrid.halfRows * 2, Math.max(0, p.y))) }));
    };
    if (phase === "down") {
      if (p.button === 2 || tool === "wl") {
        drag.current = { kind: "wl", x: p.x, y: p.y, win };
        return;
      }
      if (p.button !== 0) return;
      if (tool === "measure") {
        drag.current = { kind: "measure", pane: "cpr", planeKey: gridKey(cprGrid), a: [p.x, p.y], pixelMm: frames.stepMm, approx: true };
        return;
      }
      drag.current = { kind: "scrub" };
      scrub();
      return;
    }
    if (phase === "move") {
      if (moveCommon(p)) return;
      const d = drag.current;
      if (d?.kind === "scrub") scrub();
      else if (d?.kind === "measure") {
        const mm = Math.hypot(p.x - d.a[0], p.y - d.a[1]) * d.pixelMm;
        setDraftMeasure({ id: -1, pane: d.pane, planeKey: d.planeKey, a: d.a, b: [p.x, p.y], mm, approx: true });
      }
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "measure") finishMeasure();
  };

  const onCsPointer = (phase: "down" | "move" | "up", p: PanePointer) => {
    if (!csGrid) return;
    if (phase === "down") {
      if (p.button === 2 || tool === "wl") {
        drag.current = { kind: "wl", x: p.x, y: p.y, win };
        return;
      }
      if (tool === "measure" && p.button === 0) {
        const g2 = csGrid;
        drag.current = {
          kind: "measure",
          pane: "cs",
          planeKey: gridKey(g2),
          a: [p.x, p.y],
          pixelMm: norm(g2.du),
          toPatient: (x, y) => [g2.origin[0] + g2.du[0] * x + g2.dv[0] * y, g2.origin[1] + g2.du[1] * x + g2.dv[1] * y, g2.origin[2] + g2.du[2] * x + g2.dv[2] * y],
        };
        return;
      }
      if (p.button === 0) {
        const g2 = csGrid;
        setState((st) => ({ ...st, center: [g2.origin[0] + g2.du[0] * p.x + g2.dv[0] * p.y, g2.origin[1] + g2.du[1] * p.x + g2.dv[1] * p.y, g2.origin[2] + g2.du[2] * p.x + g2.dv[2] * p.y] }));
        return;
      }
    }
    if (phase === "move") {
      if (moveCommon(p)) return;
      const d = drag.current;
      if (d?.kind === "measure") {
        const b: [number, number] = [p.x, p.y];
        setDraftMeasure({ id: -1, pane: d.pane, planeKey: d.planeKey, a: d.a, b, mm: d.toPatient ? norm(sub(d.toPatient(b[0], b[1]), d.toPatient(d.a[0], d.a[1]))) : 0 });
      }
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "measure") finishMeasure();
  };

  // Keyboard (focus inside the workspace).
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!rootRef.current?.contains(document.activeElement)) return;
      if ((e.target as HTMLElement | null)?.closest("input, select, textarea")) return;
      if (e.key === "Escape") {
        if (tool !== "crosshair") {
          setTool("crosshair");
          e.preventDefault();
          e.stopPropagation();
        }
      } else if ((e.key === "Backspace" || e.key === "Delete") && tool === "curve" && curve?.points.length) {
        e.preventDefault();
        e.stopPropagation();
        setCurve((c) => (c ? { ...c, points: selectedPoint != null ? removePoint(c.points, selectedPoint) : c.points.slice(0, -1) } : c));
        setSelectedPoint(null);
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const dir = e.key === "ArrowUp" ? 1 : -1;
        e.preventDefault();
        e.stopPropagation();
        if (active === "cs" || active === "cpr") setStation((s) => (frames ? Math.min(frames.lengthMm, Math.max(0, s + dir)) : s));
        else {
          const i = Number(active.slice(1));
          if (i >= 0 && i <= 2) setState((s) => scrollPane(s, i, dir * step * (e.shiftKey ? 5 : 1)));
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tool, curve, selectedPoint, active, frames, step]);

  // ───── overlays ─────
  const measureOverlay = (pane: string, grid: SampleGrid | null) => {
    const key = gridKey(grid);
    const list = [...measures.filter((m) => m.pane === pane && m.planeKey === key), ...(draftMeasure?.pane === pane ? [draftMeasure] : [])];
    return list.map((m) => (
      <g key={m.id}>
        <line x1={m.a[0]} y1={m.a[1]} x2={m.b[0]} y2={m.b[1]} className="stroke-accent" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <circle cx={m.a[0]} cy={m.a[1]} r={1.5} className="fill-accent" />
        <circle cx={m.b[0]} cy={m.b[1]} r={1.5} className="fill-accent" />
      </g>
    ));
  };
  const measureLabels = (pane: string, grid: SampleGrid | null, w: number, h: number) => {
    const key = gridKey(grid);
    const list = [...measures.filter((m) => m.pane === pane && m.planeKey === key), ...(draftMeasure?.pane === pane ? [draftMeasure] : [])];
    return list.map((m) => (
      <span
        key={`l${m.id}`}
        className="pointer-events-none absolute -translate-y-full whitespace-nowrap text-[11px] tabular-nums text-white text-halo"
        // Dynamic position next to the measurement's end.
        style={{ left: `${((m.b[0] + 0.5) / w) * 100}%`, top: `${((m.b[1] + 0.5) / h) * 100}%` }}
      >
        {m.approx ? "≈ " : ""}
        {m.mm.toFixed(1)} mm
      </span>
    ));
  };

  const curveOverlay = (grid: PaneGrid) => {
    if (!curve) return null;
    const tol = Math.max(3, slab.mm / 2);
    const pts = curve.points.map((q) => patientToPane(grid, q));
    const smooth = frames ? frames.points.filter((_, i) => i % 2 === 0).map((q) => patientToPane(grid, q)) : [];
    const st = frames ? frameAt(frames, station) : null;
    const sp = st ? patientToPane(grid, st.point) : null;
    const tick = st ? patientToPane(grid, add3(st.point, scale(st.right, 6))) : null;
    const tick2 = st ? patientToPane(grid, add3(st.point, scale(st.right, -6))) : null;
    return (
      <g>
        {smooth.length > 1 && (
          <polyline points={smooth.map((q) => `${q.x},${q.y}`).join(" ")} className="fill-none stroke-warning" strokeWidth={1.5} strokeOpacity={0.85} vectorEffect="non-scaling-stroke" />
        )}
        {pts.map((q, n) => (
          <circle
            key={n}
            cx={q.x}
            cy={q.y}
            r={Math.max(2, grid.width / 160)}
            className={n === selectedPoint ? "fill-accent stroke-white" : "fill-warning stroke-black"}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            opacity={Math.abs(q.depthMm) <= tol ? 1 : 0.35}
          />
        ))}
        {sp && tick && tick2 && mode === "curved" && (
          <line x1={tick.x} y1={tick.y} x2={tick2.x} y2={tick2.y} className="stroke-accent" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        )}
      </g>
    );
  };

  const obliquePane = (i: number, extraClass?: string) => {
    const grid = grids[i];
    const img = images[i];
    const name = planeName(paneNormal(state.panes[i]));
    const edges = edgeLetters(state.panes[i].u, state.panes[i].v);
    const c = grid ? patientToPane(grid, state.center) : null;
    const lines = crosshairLines(state, i);
    const r = grid ? handleRadius(grid) : 0;
    const big = grid ? Math.max(grid.width, grid.height) * 2 : 0;
    return (
      <div key={`p${i}`} ref={paneRefs[i]} className={cn("relative min-h-0 min-w-0", extraClass)}>
        <ReconPane
          image={img.image}
          busy={img.busy}
          error={img.error}
          ww={win[0]}
          wc={win[1]}
          invert={invert}
          label={`${name.label} reconstruction`}
          active={active === `p${i}`}
          onFocus={() => setActive(`p${i}`)}
          cursor={tool === "pan" ? "grab" : "crosshair"}
          onPointer={onObliquePointer(i)}
          onWheel={onObliqueWheel(i)}
        >
          {grid && c && img.image && (
            <>
              {lines.map((l) => (
                <g key={l.pane}>
                  <line
                    x1={c.x - l.dir[0] * big}
                    y1={c.y - l.dir[1] * big}
                    x2={c.x + l.dir[0] * big}
                    y2={c.y + l.dir[1] * big}
                    className={strokeOf(l.pane)}
                    strokeWidth={1}
                    strokeOpacity={0.8}
                    vectorEffect="non-scaling-stroke"
                  />
                  {tool === "crosshair" &&
                    [1, -1].map((sgn) => (
                      <circle key={sgn} cx={c.x + l.dir[0] * r * sgn} cy={c.y + l.dir[1] * r * sgn} r={Math.max(2.5, grid.width / 110)} className={cn(fillOf(l.pane), "stroke-black")} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    ))}
                </g>
              ))}
              {curveOverlay(grid)}
              {measureOverlay(`p${i}`, grid)}
            </>
          )}
        </ReconPane>
        <div className="pointer-events-none absolute inset-0 text-[11px] text-white/90 text-halo tabular-nums">
          <div className={cn("absolute left-2 top-2 font-semibold", textOf(i))}>{name.label}</div>
          <div className="absolute bottom-2 left-2 space-y-0.5">
            <div>
              W {Math.round(win[0])} · L {Math.round(win[1])}
            </div>
            {slabText(slab) && <div className="text-accent-bright">{slabText(slab)}</div>}
          </div>
          <EdgeLabels {...edges} />
          {grid && <ScaleBar pixelMm={grid.pixelMm} width={grid.width} />}
          {grid && measureLabels(`p${i}`, grid, grid.width, grid.height)}
        </div>
      </div>
    );
  };

  // CPR labels: top / bottom from "up" at the section; ends of the curve left / right.
  const cprEdges = frames
    ? (() => {
        const f = frameAt(frames, station);
        return { top: directionLetters(f.up), bottom: directionLetters(scale(f.up, -1)), left: "Start", right: "End" };
      })()
    : null;
  const csEdges = csGrid ? edgeLetters(csGrid.right, csGrid.down) : null;

  const exportActive = async () => {
    const wrap = rootRef.current?.querySelector<HTMLElement>(`[data-recon-pane="${active}"]`);
    const canvas = wrap?.querySelector("canvas");
    if (!wrap || !canvas || !canvas.width) return;
    const out = document.createElement("canvas");
    const k = 2;
    out.width = canvas.width * k;
    out.height = canvas.height * k;
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    const svg = wrap.querySelector("svg");
    if (svg) {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", String(out.width));
      clone.setAttribute("height", String(out.height));
      // Tailwind classes do not survive serialisation: inline the computed colours.
      const live = svg.querySelectorAll("*");
      clone.querySelectorAll("*").forEach((node, n) => {
        const cs = getComputedStyle(live[n] as Element);
        (node as SVGElement).setAttribute("style", `stroke:${cs.stroke};fill:${cs.fill};stroke-opacity:${cs.strokeOpacity};opacity:${cs.opacity}`);
      });
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
      const im = new Image();
      await new Promise<void>((res) => {
        im.onload = () => res();
        im.onerror = () => res();
        im.src = url;
      });
      if (im.naturalWidth) ctx.drawImage(im, 0, 0, out.width, out.height);
    }
    // Text: the pane's labels (orientation, slab, W/L, measurements) — no patient identifiers.
    ctx.font = `${12 * k}px Inter, -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 3 * k;
    ctx.textBaseline = "top";
    const labels = [...wrap.querySelectorAll<HTMLElement>("[data-export-text]")].map((el) => el.innerText).filter(Boolean);
    labels.forEach((t, n) => ctx.fillText(t, 8 * k, 8 * k + n * 16 * k));
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
    if (!blob) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = `flowrad-recon-${active}.png`;
    if (source.saveImage) await source.saveImage(bytes, name);
    else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  };

  const toolButtons: { tool: Tool; label: string; icon: ReactNode; curvedOnly?: boolean }[] = [
    { tool: "crosshair", label: "Crosshair: click to move, drag a handle to rotate", icon: <Crosshair /> },
    { tool: "wl", label: "Window / level (or right-drag)", icon: <SunMedium /> },
    { tool: "pan", label: "Pan (or middle-drag)", icon: <Hand /> },
    { tool: "measure", label: "Measure length (mm)", icon: <Ruler /> },
    { tool: "curve", label: "Curve: click points along the structure", icon: <Spline /> },
  ];

  const exportText = (lines: (string | null | undefined)[]) =>
    lines.filter(Boolean).map((t, n) => (
      <span key={n} data-export-text hidden>
        {t}
      </span>
    ));

  return (
    <div ref={rootRef} className="flex min-h-0 min-w-0 flex-1 flex-col" data-recon-workspace>
      <div role="toolbar" aria-label="Reconstruction controls" className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-subtle bg-surface px-2 py-1 text-xs">
        <Button size="sm" variant="ghost" onClick={onExit} leadingIcon={<ArrowLeft className="h-4 w-4" />}>
          Images
        </Button>
        <span className="max-w-[16rem] truncate font-semibold text-primary" title={title}>
          {title}
        </span>
        <span aria-hidden className="h-5 w-px bg-subtle" />
        <div role="radiogroup" aria-label="Reconstruction" className="flex items-center gap-1">
          {(["oblique", "curved"] as const).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={mode === m ? "primary" : "ghost"}
              role="radio"
              aria-checked={mode === m}
              onClick={() => {
                setMode(m);
                if (m === "curved") setTool("curve");
                else if (tool === "curve") setTool("crosshair");
              }}
            >
              {m === "oblique" ? "Multi-oblique" : "Curved"}
            </Button>
          ))}
        </div>
        <span aria-hidden className="h-5 w-px bg-subtle" />
        {toolButtons.map((t) => (
          <IconButton
            key={t.tool}
            aria-label={t.label}
            title={t.label}
            size="sm"
            aria-pressed={tool === t.tool}
            onClick={() => {
              setTool(t.tool);
              if (t.tool === "curve") setMode("curved");
            }}
            className={cn("rounded-md", tool === t.tool && "bg-accent text-accent-foreground hover:bg-accent")}
          >
            {t.icon}
          </IconButton>
        ))}
        <span aria-hidden className="h-5 w-px bg-subtle" />
        <span className="text-secondary">Planes</span>
        <SlabSelect value={slab} onChange={setSlab} label="Planes" />
        <select
          aria-label="Plane alignment"
          value={align}
          onChange={(e) => {
            const a = e.target.value as "patient" | "acquisition";
            setAlign(a);
            setState((s) => ({ ...initialOblique(g, a), center: s.center }));
          }}
          className="h-7 rounded-md border border-subtle bg-elevated px-1 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <option value="patient">Patient axes</option>
          <option value="acquisition">Scan plane</option>
        </select>
        <IconButton aria-label="Zoom in (all panes)" title="Zoom in · Ctrl/⌘+wheel on a pane" size="sm" className="rounded-md" onClick={() => setViews((vs) => vs.map((v) => ({ ...v, fovMm: Math.max(5, v.fovMm / 1.25) })))}>
          <ZoomIn />
        </IconButton>
        <IconButton aria-label="Zoom out (all panes)" title="Zoom out" size="sm" className="rounded-md" onClick={() => setViews((vs) => vs.map((v) => ({ ...v, fovMm: Math.min(extent * 4, v.fovMm * 1.25) })))}>
          <ZoomOut />
        </IconButton>
        <Button size="sm" variant="ghost" aria-pressed={invert} onClick={() => setInvert((v) => !v)}>
          Invert
        </Button>
        <IconButton aria-label="Export the selected pane as PNG" title="Export the selected pane (PNG)" size="sm" className="rounded-md" onClick={() => setExporting(true)}>
          <Download />
        </IconButton>
        <IconButton aria-label="Reset planes, zoom and window" title="Reset" size="sm" className="ml-auto rounded-md" onClick={resetAll}>
          <RotateCcw />
        </IconButton>
      </div>
      {source.note && <div className="border-b border-subtle bg-surface px-3 py-1 text-xs text-warning">{source.note}</div>}

      {mode === "oblique" ? (
        <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-px bg-black">
          {[0, 1, 2].map((i) => (
            <div key={i} data-recon-pane={`p${i}`} className="relative min-h-0 min-w-0">
              {obliquePane(i, "h-full w-full")}
              {exportText([planeName(paneNormal(state.panes[i])).label, slabText(slab), `W ${Math.round(win[0])} L ${Math.round(win[1])}`])}
            </div>
          ))}
          <div className="min-h-0 overflow-auto bg-surface p-3 text-xs text-secondary">
            <p className="font-semibold text-primary">Multi-oblique MPR</p>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              <li>Click or drag in a pane: the crosshair moves and the other planes follow.</li>
              <li>Drag a coloured handle to turn the other two planes; repeat in a second pane for a double oblique.</li>
              <li>Wheel scrolls a pane (Shift ×5) · Ctrl/⌘+wheel zooms · right-drag window / level · middle-drag pans.</li>
              <li>Slab: MIP, MinIP or average at any thickness, through every plane.</li>
            </ul>
            <p className="mt-3 tabular-nums">
              Volume {g.dims[0]} × {g.dims[1]} × {g.dims[2]} · {g.spacing.map((s) => s.toFixed(2)).join(" × ")} mm
            </p>
            {images.some((im) => im.ms != null) && (
              <p className="tabular-nums text-muted">Last reconstruction: {images.map((im) => (im.ms == null ? "–" : `${Math.round(im.ms)} ms`)).join(" · ")}</p>
            )}
            <p className="mt-3 text-muted">Not for diagnostic use.</p>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-px bg-black">
          <div className="relative row-span-2 min-h-0 min-w-0">
            <div className="grid h-full grid-rows-3 gap-px">
              {[0, 1, 2].map((i) => (
                <div key={i} data-recon-pane={`p${i}`} className="relative min-h-0 min-w-0">
                  {obliquePane(i, "h-full w-full")}
                  {exportText([planeName(paneNormal(state.panes[i])).label, slabText(slab)])}
                </div>
              ))}
            </div>
          </div>
          <div data-recon-pane="cpr" className="relative flex min-h-0 min-w-0 flex-col bg-imaging">
            <div className="flex shrink-0 flex-wrap items-center gap-2 bg-surface/90 px-2 py-1 text-[11px] text-secondary">
              <span className="font-semibold text-primary">Straightened CPR</span>
              <label className="flex items-center gap-1">
                Rotate
                <input type="range" min={-180} max={180} step={5} value={cprRotation} onChange={(e) => setCprRotation(Number(e.target.value))} aria-label="Rotate the curved plane about the centreline (degrees)" className="w-20 accent-accent" />
                <span className="w-9 tabular-nums text-primary">{cprRotation}°</span>
              </label>
              <label className="flex items-center gap-1">
                Height
                <input type="range" min={5} max={100} step={1} value={cprHalf} onChange={(e) => setCprHalf(Number(e.target.value))} aria-label="Half height of the curved image (mm)" className="w-16 accent-accent" />
                <span className="w-12 tabular-nums text-primary">±{cprHalf} mm</span>
              </label>
              <SlabSelect value={cprSlab} onChange={setCprSlab} label="Curved image" />
            </div>
            <div ref={refCpr} className="relative flex min-h-0 flex-1 items-center justify-center">
              {frames && cprGrid ? (
                <div
                  className="relative max-h-full max-w-full"
                  // Dynamic geometry: the CPR's true aspect (columns × rows, mm-square pixels).
                  style={{ aspectRatio: `${cprImg.image?.width ?? cprGrid.points.length} / ${cprImg.image?.height ?? cprGrid.halfRows * 2 + 1}`, width: "100%" }}
                >
                  <ReconPane
                    image={cprImg.image}
                    busy={cprImg.busy}
                    error={cprImg.error}
                    ww={win[0]}
                    wc={win[1]}
                    invert={invert}
                    label="Straightened curved reconstruction"
                    active={active === "cpr"}
                    onFocus={() => setActive("cpr")}
                    cursor="crosshair"
                    onPointer={onCprPointer}
                  >
                    {cprImg.image && (
                      <>
                        <line x1={station / frames.stepMm} y1={0} x2={station / frames.stepMm} y2={cprImg.image.height} className="stroke-accent" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                        {stations.map((s) => (
                          <line key={s} x1={s / frames.stepMm} y1={cprImg.image!.height * 0.45} x2={s / frames.stepMm} y2={cprImg.image!.height * 0.55} className="stroke-accent" strokeOpacity={0.6} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                        ))}
                        {measureOverlay("cpr", cprGrid)}
                      </>
                    )}
                  </ReconPane>
                  <div className="pointer-events-none absolute inset-0 text-[11px] text-white/90 text-halo tabular-nums">
                    {cprEdges && <EdgeLabels {...cprEdges} />}
                    <div className="absolute bottom-2 left-2">
                      {Math.round(frames.lengthMm)} mm · section at {station.toFixed(1)} mm{slabText(cprSlab) ? ` · ${slabText(cprSlab)}` : ""}
                    </div>
                    {cprImg.image && <ScaleBar pixelMm={frames.stepMm} width={cprImg.image.width} />}
                    {cprImg.image && measureLabels("cpr", cprGrid, cprImg.image.width, cprImg.image.height)}
                  </div>
                  {exportText(["Straightened CPR", `${Math.round(frames.lengthMm)} mm`, slabText(cprSlab), cprRotation ? `rotated ${cprRotation}°` : null])}
                </div>
              ) : (
                <p className="max-w-xs p-4 text-center text-xs text-white/70">
                  Click points along the structure on any plane (scroll between clicks to follow it). The straightened image appears with two points.
                </p>
              )}
            </div>
          </div>
          <div className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-px bg-black">
            <div data-recon-pane="cs" className="relative flex min-h-0 min-w-0 flex-col bg-imaging">
              <div className="flex shrink-0 flex-wrap items-center gap-2 bg-surface/90 px-2 py-1 text-[11px] text-secondary">
                <span className="font-semibold text-primary">Cross-section</span>
                <label className="flex items-center gap-1">
                  Field
                  <input type="range" min={10} max={150} step={1} value={csSize} onChange={(e) => setCsSize(Number(e.target.value))} aria-label="Cross-section field of view (mm)" className="w-16 accent-accent" />
                  <span className="w-12 tabular-nums text-primary">{csSize} mm</span>
                </label>
                <SlabSelect value={csSlab} onChange={setCsSlab} label="Cross-section" />
              </div>
              <div ref={refCs} className="relative flex min-h-0 flex-1 items-center justify-center">
                {frames && csGrid ? (
                  <div className="relative aspect-square h-full max-h-full max-w-full">
                    <ReconPane
                      image={csImg.image}
                      busy={csImg.busy}
                      error={csImg.error}
                      ww={win[0]}
                      wc={win[1]}
                      invert={invert}
                      label="Cross-section perpendicular to the curve"
                      active={active === "cs"}
                      onFocus={() => setActive("cs")}
                      cursor="crosshair"
                      onPointer={onCsPointer}
                    >
                      {csImg.image && (
                        <>
                          <circle cx={(csImg.image.width - 1) / 2} cy={(csImg.image.height - 1) / 2} r={Math.max(1.5, csImg.image.width / 80)} className="fill-none stroke-warning" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                          {measureOverlay("cs", csGrid)}
                        </>
                      )}
                    </ReconPane>
                    <div className="pointer-events-none absolute inset-0 text-[11px] text-white/90 text-halo tabular-nums">
                      {csEdges && <EdgeLabels {...csEdges} />}
                      <div className="absolute bottom-2 left-2">
                        {station.toFixed(1)} mm{slabText(csSlab) ? ` · ${slabText(csSlab)}` : ""}
                      </div>
                      {csImg.image && <ScaleBar pixelMm={norm(csGrid.du)} width={csImg.image.width} />}
                      {csImg.image && measureLabels("cs", csGrid, csImg.image.width, csImg.image.height)}
                    </div>
                    {exportText(["Cross-section", `${station.toFixed(1)} mm along the curve`, slabText(csSlab)])}
                  </div>
                ) : (
                  <p className="p-3 text-center text-xs text-white/60">Sections appear once the curve has two points.</p>
                )}
              </div>
              {frames && (
                <input
                  type="range"
                  min={0}
                  max={Math.max(0.1, frames.lengthMm)}
                  step={0.5}
                  value={station}
                  onChange={(e) => setStation(Number(e.target.value))}
                  aria-label="Cross-section position along the curve (mm)"
                  className="mx-2 mb-1 shrink-0 accent-accent"
                />
              )}
            </div>
            <div className="flex min-h-0 flex-col bg-surface">
              <label className="flex shrink-0 items-center gap-1 px-2 py-1 text-[11px] text-secondary">
                Every
                <input type="range" min={1} max={30} step={1} value={stripInterval} onChange={(e) => setStripInterval(Number(e.target.value))} aria-label="Spacing between neighbouring sections (mm)" className="w-14 accent-accent" />
                <span className="tabular-nums text-primary">{stripInterval} mm</span>
              </label>
              <div className="flex min-h-0 flex-1 flex-col gap-px overflow-auto bg-black">
                {frames &&
                  stations.map((s, n) => (
                    <StripSection key={n} index={n} source={source} frames={frames} s={s} sizeMm={csSize} slab={slabOf(csSlab)} ww={win[0]} wc={win[1]} invert={invert} current={Math.abs(s - station) < 1e-6} onPick={() => setStation(s)} step={step} />
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {exporting && (
        <div role="dialog" aria-modal="true" aria-label="Export reconstruction" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-strong bg-elevated p-4 text-sm text-primary shadow-xl">
            <p className="font-semibold">Export the selected pane as PNG</p>
            <p className="mt-2 text-secondary">{BURNED_IN_WARNING}</p>
            <p className="mt-2 text-secondary">The image includes the crosshair, curve and measurements drawn on it and its orientation / slab labels. It carries no patient name or ID.</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setExporting(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setExporting(false);
                  void exportActive();
                }}
              >
                Export PNG
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function StripSection({
  index,
  source,
  frames,
  s,
  sizeMm,
  slab,
  ww,
  wc,
  invert,
  current,
  onPick,
  step,
}: {
  index: number;
  source: ReconSource;
  frames: CurveFrames;
  s: number;
  sizeMm: number;
  slab?: { mode: Projection; thicknessMm: number };
  ww: number;
  wc: number;
  invert: boolean;
  current: boolean;
  onPick: () => void;
  step: number;
}) {
  const grid = useStableGrid(crossSectionGrid(frames, s, sizeMm, Math.max(sizeMm / 96, step / 2), slab));
  const img = useReconImage(source, grid, `strip-${index}`);
  return (
    <button type="button" onClick={onPick} aria-label={`Section at ${s.toFixed(1)} mm`} className={cn("relative aspect-square w-full shrink-0 bg-imaging focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent", current && "ring-1 ring-inset ring-accent")}>
      <ReconPane image={img.image} busy={img.busy} error={img.error} ww={ww} wc={wc} invert={invert} label={`Section at ${s.toFixed(1)} mm`} />
      <span className="pointer-events-none absolute bottom-1 left-1 text-[10px] tabular-nums text-white text-halo">{s.toFixed(1)} mm</span>
    </button>
  );
}

export { PANE_COLORS };
