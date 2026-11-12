/**
 * JSON sidecar for a sketch export: everything DICOM cannot hold cleanly —
 * when each stroke was drawn on the narration clock, how long it took, the
 * per-point timing for progressive replay, and the narration sentence it was
 * drawn under. Ties back to the SR by Tracking Unique Identifier.
 */

import { linkSketchesToNarration, type SketchNarrationLink } from "../teacherSketch";
import type { NarrationSpan, RecordedEvent, TeacherSketchItem } from "../types";

export const SIDECAR_SCHEMA = "flowrad.sketch-sidecar/1";

export interface SketchSidecar {
  schema: typeof SIDECAR_SCHEMA;
  caseId: string;
  exportedAt: string;
  durationMs?: number;
  /** Coordinate conventions, spelled out for whoever reads this next. */
  coordinates: {
    fraction: string;
    index: string;
    scoord: string;
    patient: string;
  };
  items: Array<TeacherSketchItem & { timeline?: Omit<SketchNarrationLink, "image" | "id" | "kind"> ; trackingUid?: string }>;
  narration: NarrationSpan[];
  sr?: { sopInstanceUID: string; seriesInstanceUID: string };
}

export function buildSketchSidecar(input: {
  caseId: string;
  items: readonly TeacherSketchItem[];
  events?: readonly RecordedEvent[];
  narration?: readonly NarrationSpan[];
  durationMs?: number;
  trackingUids?: Record<string, string>;
  sr?: { sopInstanceUID: string; seriesInstanceUID: string };
  now?: Date;
}): SketchSidecar {
  const links = new Map(
    linkSketchesToNarration(input.events ?? [], input.narration ?? []).map((link) => [link.id, link])
  );
  return {
    schema: SIDECAR_SCHEMA,
    caseId: input.caseId,
    exportedAt: (input.now ?? new Date()).toISOString(),
    ...(input.durationMs != null ? { durationMs: input.durationMs } : {}),
    coordinates: {
      fraction: "x_pct/y_pct in [0,1]; index = fraction × (columns−1 | rows−1)",
      index: "col/row continuous pixel index, pixel centre on the integer",
      scoord: "SR SCOORD / GSPS PIXEL = index + 0.5 (origin at the top-left corner of the first pixel)",
      patient: "mm = DICOM patient LPS: IPP + rowCosines·PixelSpacing[1]·col + columnCosines·PixelSpacing[0]·row",
    },
    items: input.items.map((item) => {
      const link = links.get(item.id);
      const timeline = link
        ? (({ id: _id, kind: _kind, image: _image, ...rest }) => rest)(link)
        : undefined;
      return {
        ...item,
        ...(timeline ? { timeline } : {}),
        ...(input.trackingUids?.[item.id] ? { trackingUid: input.trackingUids[item.id] } : {}),
      };
    }),
    narration: [...(input.narration ?? [])],
    ...(input.sr ? { sr: input.sr } : {}),
  };
}
