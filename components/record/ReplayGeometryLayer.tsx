"use client";
import type { ProjectedReplayShape } from "@/lib/replay/types";
/** Original image pixels projected by the displayed DICOM viewport, with no stroke interpolation. */
export function ReplayGeometryLayer({ shapes }: { shapes: ProjectedReplayShape[] }) {
  if (!shapes.length) return null;
  return <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-hidden text-accent" aria-label="Recorded image annotations" data-replay-geometry={JSON.stringify(shapes)}>
    {shapes.map(s => {
      const p = s.canvasPoints, first = p[0];
      const ellipse = s.tool === 'EllipticalROI' ? { cx: (p[0].x + p[1].x) / 2, cy: (p[0].y + p[1].y) / 2, rx: Math.hypot(p[3].x - p[2].x, p[3].y - p[2].y) / 2, ry: Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) / 2, angle: Math.atan2(p[3].y - p[2].y, p[3].x - p[2].x) * 180 / Math.PI } : null;
      const label = [s.label, s.lengthMm === null ? (s.tool === 'Length' ? 'uncalibrated' : '') : `${s.lengthMm.toFixed(2)} mm (${s.geometry.calibration})`].filter(Boolean).join(' · ');
      return <g key={s.id} data-anchor-id={s.id} fill="none" stroke="currentColor" strokeWidth="2">
        {s.tool === 'marker' || s.tool === 'Probe' ? <circle cx={first.x} cy={first.y} r="6" /> : s.tool === 'EllipticalROI' ? <ellipse cx={ellipse!.cx} cy={ellipse!.cy} rx={ellipse!.rx} ry={ellipse!.ry} transform={`rotate(${ellipse!.angle} ${ellipse!.cx} ${ellipse!.cy})`} /> : s.tool === 'RectangleROI' ? <polygon points={[p[0], p[1], p[3], p[2]].map(p => `${p.x},${p.y}`).join(" ")} /> : s.tool === 'Bidirectional' ? <><line x1={p[0].x} y1={p[0].y} x2={p[1].x} y2={p[1].y} /><line x1={p[2].x} y1={p[2].y} x2={p[3].x} y2={p[3].y} /></> : <polyline points={p.map(p => `${p.x},${p.y}`).join(' ')} />}
        {label && <text x={first.x + 9} y={first.y - 9} className="text-xs" fill="currentColor" stroke="none">{label}</text>}
      </g>;
    })}
  </svg>;
}
