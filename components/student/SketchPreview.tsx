"use client";

// Visual fixture for the sketch layer. No PACS: a fitted camera and a
// schematic axial so desktop and phone tests can see draw-in, anchoring,
// slice hiding, and the 3D panel.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { materializeLiveTeachingPack } from "@/lib/liveTeachingPack";
import { replaySketches } from "@/lib/sketchMarks";
import { fitScaleFor, frameFromCamera, type StackCamera } from "@/lib/sketchProjection";
import type { Finding } from "@/lib/types";
import { AnatomyPanel } from "./AnatomyPanel";
import { SketchOverlay } from "./SketchOverlay";

const finding: Finding = {
  id: "f1",
  label: "Spiculated nodule",
  description: "Irregular margin in the right upper lobe.",
  teachingPoints: ["Malignancy until proven otherwise."],
  state: " ",
  marker: { x_pct: 0.34, y_pct: 0.42, shape: "circle" },
  order: 1,
  sliceIndex: 12,
  windowWidth: 1500,
  windowCenter: -600,
  seriesInstanceUID: "1.2.preview",
  measurements: [
    {
      id: "m1",
      kind: "arrow",
      handles: [
        [0.18, 0.24],
        [0.34, 0.42],
      ],
    },
  ],
};

function ellipse(
  frame: ReturnType<typeof frameFromCamera>,
  cx: number,
  cy: number,
  rx: number,
  ry: number
) {
  const center = frame.project(cx, cy);
  const east = frame.project(cx + rx, cy);
  const south = frame.project(cx, cy + ry);
  if (!center || !east || !south) return null;
  return {
    cx: center.x,
    cy: center.y,
    rx: Math.abs(east.x - center.x),
    ry: Math.abs(south.y - center.y),
  };
}

export function SketchPreview() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 640 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(0);
  const [slice, setSlice] = useState(12);
  const [generation, setGeneration] = useState(1);
  const [anatomy, setAnatomy] = useState(false);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pack = useMemo(
    () =>
      materializeLiveTeachingPack({
        caseId: "preview",
        modality: "CT",
        findings: [finding],
      }),
    []
  );
  const marks = useMemo(() => replaySketches(pack, "f1", generation), [pack, generation]);
  const camera = useMemo<StackCamera>(() => {
    const columns = 512;
    const rows = 512;
    return {
      columns,
      rows,
      canvasWidth: Math.max(2, size.width),
      canvasHeight: Math.max(2, size.height),
      fitScale: fitScaleFor(columns, rows, Math.max(2, size.width), Math.max(2, size.height)),
      zoom,
      panX: pan,
      panY: 0,
    };
  }, [size.width, size.height, zoom, pan]);
  const frame = useMemo(() => frameFromCamera(camera, slice), [camera, slice]);
  const body = ellipse(frame, 0.5, 0.52, 0.42, 0.4);
  const rightLung = ellipse(frame, 0.36, 0.48, 0.16, 0.22);
  const leftLung = ellipse(frame, 0.66, 0.5, 0.14, 0.2);
  const spine = ellipse(frame, 0.5, 0.72, 0.045, 0.045);

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-imaging text-white">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#1F1F1F] bg-[#181818] px-3 py-2">
        <p className="font-hand text-xl leading-none text-[#FFE14A]">Sketch preview</p>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setZoom((value) => (value > 1.2 ? 1 : 1.85))}>
            {zoom > 1.2 ? "Fit" : "Zoom in"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setPan((value) => (value > 20 ? 0 : 90))}>
            {pan > 20 ? "Center" : "Pan"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setSlice((value) => (value === 12 ? 30 : 12))}>
            {slice === 12 ? "Other slice" : "Key slice"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setGeneration((value) => value + 1)}>
            Replay marks
          </Button>
          <Button size="sm" variant={anatomy ? "primary" : "secondary"} onClick={() => setAnatomy((open) => !open)}>
            {anatomy ? "Hide 3D" : "Show in 3D"}
          </Button>
        </div>
        <p className="ml-auto font-mono text-xs tabular-nums text-white/70">
          slice {slice} · zoom {zoom.toFixed(2)}
        </p>
      </header>
      <div ref={stageRef} className="relative min-h-0 flex-1 bg-black" data-testid="sketch-stage">
        <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
          {body && <ellipse cx={body.cx} cy={body.cy} rx={body.rx} ry={body.ry} fill="#141414" stroke="#2a2a2a" />}
          {rightLung && <ellipse cx={rightLung.cx} cy={rightLung.cy} rx={rightLung.rx} ry={rightLung.ry} fill="#101418" stroke="#243038" />}
          {leftLung && <ellipse cx={leftLung.cx} cy={leftLung.cy} rx={leftLung.rx} ry={leftLung.ry} fill="#101418" stroke="#243038" />}
          {spine && <ellipse cx={spine.cx} cy={spine.cy} rx={spine.rx} ry={spine.ry} fill="#2c2418" />}
        </svg>
        <SketchOverlay marks={marks} frame={frame} />
        {anatomy && <AnatomyPanel onClose={() => setAnatomy(false)} />}
      </div>
    </div>
  );
}
