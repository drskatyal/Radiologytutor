/**
 * Finding localization & display state.
 *
 * Teaching clicks are NOT written into DICOM Pixel Data or private tags.
 * Orthanc holds immutable (de-id'd) pixels; FlowRad stores teaching state in
 * the Finding document, keyed by DICOM UIDs. See docs/FINDING_LOCALIZATION.md.
 */

import type { Finding, FindingAnchor } from "./types";
import type { CornerstoneViewerState } from "./viewerController";

/** Parse SOP Instance UID from a Cornerstone wadors:/wadouri: imageId. */
export function sopUidFromImageId(imageId: string | undefined | null): string | undefined {
  if (!imageId) return undefined;
  const m = /\/instances\/([^/?#]+)/i.exec(imageId);
  return m?.[1];
}

export type DisplaySnapshot = {
  sliceIndex: number;
  ww?: number;
  wc?: number;
  sopInstanceUID?: string;
};

/** Merge a live viewport snapshot onto a Finding / FindingAnchor draft. */
export function withDisplaySnapshot<T extends Partial<Finding> | FindingAnchor>(
  target: T,
  snap: DisplaySnapshot | null | undefined
): T {
  if (!snap) return target;
  const next = { ...target };
  if (snap.sliceIndex != null && Number.isFinite(snap.sliceIndex)) {
    (next as { sliceIndex?: number }).sliceIndex = snap.sliceIndex;
  }
  if (snap.ww != null && Number.isFinite(snap.ww)) {
    (next as { windowWidth?: number }).windowWidth = snap.ww;
  }
  if (snap.wc != null && Number.isFinite(snap.wc)) {
    (next as { windowCenter?: number }).windowCenter = snap.wc;
  }
  if (snap.sopInstanceUID) {
    (next as { sopInstanceUID?: string }).sopInstanceUID = snap.sopInstanceUID;
  }
  return next;
}

/**
 * Resolve the Cornerstone drive target for a finding: authored VOI + slice
 * win over Pacsbin-decoded camera when both exist (Cornerstone-native path).
 */
export function authoredDisplayState(
  finding: Pick<
    Finding,
    "sliceIndex" | "windowWidth" | "windowCenter" | "sopInstanceUID"
  >,
  fallback?: CornerstoneViewerState | null,
  sliceFractionHint?: number
): CornerstoneViewerState {
  const hasAuthoredVoi =
    finding.windowWidth != null &&
    finding.windowCenter != null &&
    Number.isFinite(finding.windowWidth) &&
    Number.isFinite(finding.windowCenter);

  return {
    sliceIndex:
      finding.sliceIndex != null && Number.isFinite(finding.sliceIndex)
        ? finding.sliceIndex
        : fallback?.sliceIndex,
    sliceFraction:
      finding.sliceIndex != null && Number.isFinite(finding.sliceIndex)
        ? undefined
        : (fallback?.sliceFraction ?? sliceFractionHint),
    windowWidth: hasAuthoredVoi ? finding.windowWidth : fallback?.windowWidth,
    windowCenter: hasAuthoredVoi ? finding.windowCenter : fallback?.windowCenter,
    zoom: fallback?.zoom,
    pan: fallback?.pan,
  };
}
