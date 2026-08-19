// Finding anchors — primary vs compare landings.
// A finding is one teaching unit. Extra anchors are extra viewports, not extra
// findings. Primary stays Finding.marker / seriesInstanceUID for back-compat.

import type { Finding, FindingAnchor, Marker } from "./types";

export function markerOf(finding: Finding): Marker | null {
  const m = finding.marker;
  if (!m || !Number.isFinite(m.x_pct) || !Number.isFinite(m.y_pct)) return null;
  return m;
}

export function primaryAnchor(finding: Finding): FindingAnchor {
  const fromList = (finding.anchors ?? []).find((a) => a.viewportRole !== "secondary");
  if (fromList?.marker) return fromList;
  return {
    studyInstanceUID: finding.studyInstanceUID,
    seriesInstanceUID: finding.seriesInstanceUID,
    sopInstanceUID: finding.sopInstanceUID,
    sliceIndex: finding.sliceIndex,
    marker: finding.marker,
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

/** True when the finding should open a side-by-side compare layout. */
export function wantsCompare(finding: Finding): boolean {
  const sec = secondaryAnchor(finding);
  if (!sec) return false;
  const pri = primaryAnchor(finding);
  if (
    sec.seriesInstanceUID &&
    pri.seriesInstanceUID &&
    sec.seriesInstanceUID !== pri.seriesInstanceUID
  ) {
    return true;
  }
  // Same series, different slice still earns a second pane.
  return (
    sec.sliceIndex != null &&
    pri.sliceIndex != null &&
    sec.sliceIndex !== pri.sliceIndex
  );
}

export function seriesIndexFor(
  series: { seriesInstanceUID: string }[],
  uid?: string
): number {
  if (!uid) return 0;
  const i = series.findIndex((s) => s.seriesInstanceUID === uid);
  return i >= 0 ? i : 0;
}

export function withSecondaryAnchor(
  finding: Finding,
  anchor: FindingAnchor
): FindingAnchor[] {
  const pri = { ...primaryAnchor(finding), viewportRole: "primary" as const };
  const sec = { ...anchor, viewportRole: "secondary" as const };
  return [pri, sec];
}
