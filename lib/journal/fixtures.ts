import type { ViewerSnapshot } from "./types";
/** Synthetic identity only; shared by the local journal contract tests. */
export const journalTestView: ViewerSnapshot = {
  studyUID: "1.2", seriesUID: "1.2.3", sopUID: "1.2.3.4", frame: 1, viewportId: "primary", layout: "single", renderSeq: 1,
  voi: { ww: 400, wc: 40 }, invert: false,
  camera: { zoom: 1, pan: [0, 0], rotation: 0, flipH: false, flipV: false },
  orientation: { normal: [0, 0, 1], up: [0, -1, 0] },
};
