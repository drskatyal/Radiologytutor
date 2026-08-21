"use client";

// Authored Length / Ellipse / Probe calipers redrawn over the student viewer
// from Finding.measurements handles ([0,1] overlay space). Not Cornerstone
// tools — overlay-only so pan/zoom of the imaging canvas still aligns while
// the student is parked on the authored landing. Recorded tracks that already
// painted tools during replay leave this empty (handles were live).

import { cn } from "@/components/ui/cn";
import { formatMeasurementBrief } from "@/lib/findingMeasurements";
import type { FindingMeasurement } from "@/lib/types";

export function MeasurementOverlay({
  measurements,
  visible,
}: {
  measurements: FindingMeasurement[];
  visible: boolean;
}) {
  if (!measurements.length) return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-10 transition-opacity duration-500",
        visible ? "opacity-100" : "opacity-0"
      )}
      aria-hidden="true"
    >
      <svg className="absolute inset-0 h-full w-full overflow-visible">
        {measurements.map((m) => (
          <MeasurementGraphic key={m.id} m={m} />
        ))}
      </svg>
      {measurements.map((m) => {
        const anchor = labelAnchor(m);
        if (!anchor) return null;
        return (
          <span
            key={`${m.id}-label`}
            className="absolute -translate-x-1/2 -translate-y-full rounded-sm border border-accent/40 bg-elevated/90 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-accent shadow-sm"
            style={{
              left: `${anchor[0] * 100}%`,
              top: `${anchor[1] * 100}%`,
            }}
          >
            {formatMeasurementBrief(m)}
          </span>
        );
      })}
    </div>
  );
}

function MeasurementGraphic({ m }: { m: FindingMeasurement }) {
  const pts = m.handles;
  if (pts.length === 0) return null;

  if (m.kind === "length" || m.kind === "bidirectional") {
    if (pts.length < 2) return null;
    const [a, b] = pts;
    return (
      <g>
        <line
          x1={`${a[0] * 100}%`}
          y1={`${a[1] * 100}%`}
          x2={`${b[0] * 100}%`}
          y2={`${b[1] * 100}%`}
          className="stroke-accent"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
        <HandleDot x={a[0]} y={a[1]} />
        <HandleDot x={b[0]} y={b[1]} />
      </g>
    );
  }

  if (m.kind === "ellipse") {
    const box = ellipseBox(pts);
    if (!box) return null;
    return (
      <ellipse
        cx={`${box.cx * 100}%`}
        cy={`${box.cy * 100}%`}
        rx={`${box.rx * 100}%`}
        ry={`${box.ry * 100}%`}
        className="fill-accent/10 stroke-accent"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    );
  }

  // probe — single point crosshair
  const [p] = pts;
  return (
    <g>
      <line
        x1={`${(p[0] - 0.012) * 100}%`}
        y1={`${p[1] * 100}%`}
        x2={`${(p[0] + 0.012) * 100}%`}
        y2={`${p[1] * 100}%`}
        className="stroke-accent"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1={`${p[0] * 100}%`}
        y1={`${(p[1] - 0.012) * 100}%`}
        x2={`${p[0] * 100}%`}
        y2={`${(p[1] + 0.012) * 100}%`}
        className="stroke-accent"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
}

function HandleDot({ x, y }: { x: number; y: number }) {
  return (
    <circle
      cx={`${x * 100}%`}
      cy={`${y * 100}%`}
      r={3}
      className="fill-accent stroke-canvas"
      strokeWidth={1}
    />
  );
}

function ellipseBox(
  pts: Array<[number, number]>
): { cx: number; cy: number; rx: number; ry: number } | null {
  if (pts.length < 2) return null;
  // Cornerstone EllipticalROI stores corners / axis handles — take AABB.
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = Math.max(0.004, (maxX - minX) / 2);
  const ry = Math.max(0.004, (maxY - minY) / 2);
  return { cx, cy, rx, ry };
}

function labelAnchor(m: FindingMeasurement): [number, number] | null {
  const pts = m.handles;
  if (!pts.length) return null;
  if (m.kind === "length" || m.kind === "bidirectional") {
    const a = pts[0];
    const b = pts[Math.min(1, pts.length - 1)];
    return [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - 0.02];
  }
  if (m.kind === "ellipse") {
    const box = ellipseBox(pts);
    if (!box) return null;
    return [box.cx, box.cy - box.ry - 0.02];
  }
  return [pts[0][0], pts[0][1] - 0.025];
}
