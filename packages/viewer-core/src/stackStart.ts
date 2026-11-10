// Which image a stack opens on the first time it is shown in a viewport.
//
// Axial stacks open on image 1 (head end first, as readers scroll them).
// A coronal or sagittal acquisition opens on its middle image: image 1 of a
// coronal is the skin of the back and of a sagittal the edge of the body,
// where there is nothing to read. Multiframe / cine-like series (US, XA
// loops) keep frame 1, and so does anything that is not clearly coronal or
// sagittal (oblique, no orientation). A position restored from elsewhere
// (a growing stack, a hand-off, linked scroll) is the caller's and wins.

import { orientationOf } from "./hangingProtocols";

/** Modalities whose stacks are time series (loops), not a sweep through the body. */
const CINE_MODALITIES = new Set(["US", "XA", "RF", "XRF", "ES", "IVUS", "IVOCT"]);

export interface StackStartInput {
  imageCount: number;
  /** ImageOrientationPatient of the series' first image. */
  imageOrientationPatient?: readonly number[] | null;
  modality?: string;
  /** Frames of one multiframe object (a loop). */
  multiframe?: boolean;
  /** A recorded cine rate (FrameTime / CineRate): a loop. */
  frameRate?: number | null;
}

/** The acquisition plane, when a fresh open should start mid-stack because of it. */
export function midStackPlane(s: StackStartInput): "coronal" | "sagittal" | null {
  if (!(s.imageCount > 1) || s.multiframe || s.frameRate) return null;
  if (s.modality && CINE_MODALITIES.has(s.modality.toUpperCase())) return null;
  const plane = orientationOf(s.imageOrientationPatient);
  return plane === "coronal" || plane === "sagittal" ? plane : null;
}

/** Index of the image a series opens on the first time a viewport shows it. */
export function stackStartIndex(s: StackStartInput): number {
  return midStackPlane(s) ? Math.floor(s.imageCount / 2) : 0;
}
