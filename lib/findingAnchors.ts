// Finding anchors — primary vs compare landings.
// A finding is one teaching unit. Extra anchors are extra viewports, not extra
// findings. Primary stays Finding.marker / seriesInstanceUID for back-compat.
//
// Compare is pedagogically useful only when the secondary landing is not the
// primary view again. A second series, a different slice, a different window,
// or a different camera all count. The same pixels do not.

import type { Finding, FindingAnchor, Marker } from "./types";

/** Viewer target for the compare pane. Fields absent stay as the pane left them. */
export interface SecondaryViewState {
  sliceIndex?: number;
  windowWidth?: number;
  windowCenter?: number;
  zoom?: number;
  pan?: [number, number];
}

export function markerOf(finding: Finding): Marker | null {
  const m = finding.marker;
  if (!m || !Number.isFinite(m.x_pct) || !Number.isFinite(m.y_pct)) return null;
  return m;
}

function finite(n: number | undefined | null): n is number {
  return n != null && Number.isFinite(n);
}

function apart(a: number | undefined, b: number | undefined, eps: number): boolean {
  if (!finite(a) || !finite(b)) return false;
  return Math.abs(a - b) > eps;
}

function markerApart(a: Marker | undefined, b: Marker | undefined): boolean {
  if (!a || !b || !finite(a.x_pct) || !finite(a.y_pct) || !finite(b.x_pct) || !finite(b.y_pct)) {
    return false;
  }
  return Math.hypot(a.x_pct - b.x_pct, a.y_pct - b.y_pct) > 0.02;
}

export function primaryAnchor(finding: Finding): FindingAnchor {
  const fromList = (finding.anchors ?? []).find(
    (a) => a.viewportRole !== "secondary" && a.viewportRole !== "compare"
  );
  if (fromList?.marker) return fromList;
  return {
    studyInstanceUID: finding.studyInstanceUID,
    seriesInstanceUID: finding.seriesInstanceUID,
    sopInstanceUID: finding.sopInstanceUID,
    sliceIndex: finding.sliceIndex,
    marker: finding.marker,
    windowWidth: finding.windowWidth,
    windowCenter: finding.windowCenter,
    viewportRole: "primary",
    studyRole: "current",
  };
}

export function secondaryAnchor(finding: Finding): FindingAnchor | null {
  const listed = (finding.anchors ?? []).find(
    (a) => a.viewportRole === "secondary" || a.viewportRole === "compare"
  );
  if (listed?.marker) return listed;
  return null;
}

/** True when the secondary landing is a different view, not a clone of primary. */
export function wantsCompare(finding: Finding): boolean {
  const sec = secondaryAnchor(finding);
  if (!sec) return false;
  const pri = primaryAnchor(finding);
  const priSeries = pri.seriesInstanceUID || finding.seriesInstanceUID;
  const secSeries = sec.seriesInstanceUID || priSeries;
  if (priSeries && secSeries && priSeries !== secSeries) return true;
  const priStudy = pri.studyInstanceUID || finding.studyInstanceUID;
  const secStudy = sec.studyInstanceUID || priStudy;
  if (priStudy && secStudy && priStudy !== secStudy) return true;
  const priSlice = finite(pri.sliceIndex) ? pri.sliceIndex : finding.sliceIndex;
  if (finite(sec.sliceIndex) && finite(priSlice) && sec.sliceIndex !== priSlice) return true;
  const priWw = finite(pri.windowWidth) ? pri.windowWidth : finding.windowWidth;
  const priWc = finite(pri.windowCenter) ? pri.windowCenter : finding.windowCenter;
  // 1 HU matches the viewer readout tolerance.
  if (apart(sec.windowWidth, priWw, 1) || apart(sec.windowCenter, priWc, 1)) return true;
  if (apart(sec.zoom, pri.zoom, 0.05)) return true;
  if (finite(sec.zoom) && !finite(pri.zoom) && Math.abs(sec.zoom - 1) > 0.05) return true;
  if (
    sec.pan &&
    pri.pan &&
    (apart(sec.pan[0], pri.pan[0], 0.5) || apart(sec.pan[1], pri.pan[1], 0.5))
  ) {
    return true;
  }
  if (
    sec.pan &&
    !pri.pan &&
    (Math.abs(sec.pan[0]) > 0.5 || Math.abs(sec.pan[1]) > 0.5)
  ) {
    return true;
  }
  const priMarker = pri.marker ?? finding.marker;
  return markerApart(priMarker, sec.marker);
}

/** Drive target for the compare pane. Null when compare would repeat primary. */
export function secondaryViewerState(finding: Finding): SecondaryViewState | null {
  const sec = secondaryAnchor(finding);
  if (!sec || !wantsCompare(finding)) return null;
  const state: SecondaryViewState = {};
  if (finite(sec.sliceIndex)) state.sliceIndex = sec.sliceIndex;
  if (finite(sec.windowWidth)) state.windowWidth = sec.windowWidth;
  if (finite(sec.windowCenter)) state.windowCenter = sec.windowCenter;
  if (finite(sec.zoom) && sec.zoom > 0) state.zoom = sec.zoom;
  if (
    sec.pan &&
    sec.pan.length >= 2 &&
    finite(sec.pan[0]) &&
    finite(sec.pan[1])
  ) {
    state.pan = [sec.pan[0], sec.pan[1]];
  }
  return state;
}

export function seriesIndexFor(
  series: { seriesInstanceUID: string }[],
  uid?: string
): number {
  if (!uid) return 0;
  const i = series.findIndex((s) => s.seriesInstanceUID === uid);
  return i >= 0 ? i : 0;
}

/**
 * Series index for the compare pane.
 * An authored secondary landing wins. With no landing, another real series
 * is used when the study has one. A single-series study stays on that series —
 * we do not invent a second stack.
 */
export function comparePaneSeriesIndex(
  series: { seriesInstanceUID: string }[],
  finding: Finding | null | undefined,
  activeSeriesUid?: string
): number {
  if (finding && wantsCompare(finding)) {
    const sec = secondaryAnchor(finding);
    const uid =
      sec?.seriesInstanceUID ||
      primaryAnchor(finding).seriesInstanceUID ||
      finding.seriesInstanceUID ||
      activeSeriesUid;
    return seriesIndexFor(series, uid);
  }
  if (series.length > 1) {
    const other = series.findIndex((s) => s.seriesInstanceUID !== activeSeriesUid);
    if (other >= 0) return other;
  }
  if (activeSeriesUid) return seriesIndexFor(series, activeSeriesUid);
  return 0;
}

export function withSecondaryAnchor(
  finding: Finding,
  anchor: FindingAnchor
): FindingAnchor[] {
  const pri = { ...primaryAnchor(finding), viewportRole: "primary" as const };
  const sec = { ...anchor, viewportRole: "secondary" as const };
  return [pri, sec];
}

/** Replace the primary landing and keep a pinned compare landing. */
export function withPrimaryAnchor(
  finding: Finding,
  primary: FindingAnchor
): FindingAnchor[] {
  const pri = { ...primary, viewportRole: "primary" as const };
  const sec = secondaryAnchor(finding);
  return sec ? [pri, { ...sec, viewportRole: "secondary" as const }] : [pri];
}

export function withoutSecondaryAnchor(finding: Finding): FindingAnchor[] {
  return [{ ...primaryAnchor(finding), viewportRole: "primary" as const }];
}
