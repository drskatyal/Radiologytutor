"use client";

// Reference lines from viewports in OTHER windows (another monitor, or a
// popped-out browser window): where each remote image plane cuts this
// viewport's plane, clipped to the remote image. Same frame of reference
// only; parallel planes draw nothing. Shared by desktop and web; the planes
// arrive over the window bus (`crossWindow.ts`).

import { useEffect, useState } from "react";
import { monitorColor, referenceSegment, type XVec3 } from "@flowrad/viewer-core";

/* eslint-disable @typescript-eslint/no-explicit-any -- Cornerstone modules are passed in untyped. */

export interface RemotePlane {
  /** Sender window id. */
  from: string;
  frame: string;
  corners: readonly [XVec3, XVec3, XVec3, XVec3];
  /** Sender's monitor index (colours the line like its monitor badge). */
  monitorIndex?: number;
}

export function RemoteReferenceLines({ ctx, planes }: { ctx: { core: any; element: HTMLElement } | null; planes: readonly RemotePlane[] }) {
  const [, setTick] = useState(0);

  // Redraw when this viewport's image or camera changes.
  useEffect(() => {
    if (!ctx) return;
    const ev = ctx.core.Enums.Events.IMAGE_RENDERED;
    const bump = () => setTick((t) => t + 1);
    ctx.element.addEventListener(ev, bump);
    return () => ctx.element.removeEventListener(ev, bump);
  }, [ctx]);

  if (!ctx || !planes.length) return null;
  const vp = ctx.core.getEnabledElement(ctx.element)?.viewport;
  const camera = vp?.getCamera?.();
  const frame = vp?.getFrameOfReferenceUID?.();
  if (!camera?.focalPoint || !camera?.viewPlaneNormal || !frame) return null;

  const lines = planes.flatMap((p) => {
    if (p.frame !== frame) return [];
    const seg = referenceSegment({ origin: camera.focalPoint, normal: camera.viewPlaneNormal }, p.corners);
    if (!seg) return [];
    const [a, b] = seg.map((w) => vp.worldToCanvas([...w]) as [number, number]);
    return [{ key: p.from, a, b, color: p.monitorIndex != null ? monitorColor(p.monitorIndex) : "#FACC15" }];
  });
  if (!lines.length) return null;

  return (
    <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full" data-testid="remote-reference-lines" data-count={lines.length} aria-hidden>
      {lines.map((l) => (
        <line key={l.key} x1={l.a[0]} y1={l.a[1]} x2={l.b[0]} y2={l.b[1]} stroke={l.color} strokeWidth={1.5} strokeDasharray="6 4" />
      ))}
    </svg>
  );
}
