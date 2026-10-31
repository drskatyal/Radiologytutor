// Pure renderer logic. Run: npm --prefix desktop test
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveShortcut, shortcutSheet, BINDINGS, type KeyLike } from "./shortcuts";
import { edgeLabels, directionLabel } from "./viewer/orientation";
import { buildStudies, headFirst, isVolumetric, formatPersonName, formatDicomDate, frameRateOf, primarySeriesIndex } from "./study";
import { hangSeries } from "./layout";
import { historyEntryFor, sourceKey } from "./history";
import { windowPresetsFor, voiRangeOf, wwwcOf } from "./viewer/presets";
import type { DesktopHeader } from "./types";

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({ key: k, ...extra });

test("RadiAnt tool letters map to Cornerstone tools", () => {
  const map: Record<string, string> = { b: "StackScroll", w: "WindowLevel", m: "Pan", z: "Zoom", l: "Length", a: "Angle", c: "CobbAngle", e: "EllipticalROI", y: "ArrowAnnotate", p: "PlanarFreehandROI" };
  for (const [letter, tool] of Object.entries(map)) {
    assert.deepEqual(resolveShortcut(key(letter), false), { type: "tool", tool });
    assert.deepEqual(resolveShortcut(key(letter.toUpperCase()), false), { type: "tool", tool }, "caps lock");
  }
});

test("open shortcuts: Ctrl+O files, Ctrl+Shift+O folder, Ctrl+Alt+O disc; ⌘ on macOS", () => {
  assert.deepEqual(resolveShortcut(key("o", { ctrlKey: true }), false), { type: "open", what: "files" });
  assert.deepEqual(resolveShortcut(key("O", { ctrlKey: true, shiftKey: true }), false), { type: "open", what: "folder" });
  assert.deepEqual(resolveShortcut(key("o", { ctrlKey: true, altKey: true }), false), { type: "open", what: "disc" });
  assert.deepEqual(resolveShortcut(key("o", { metaKey: true }), true), { type: "open", what: "files" });
  assert.equal(resolveShortcut(key("o", { ctrlKey: true }), true), null, "Ctrl is not Mod on macOS");
});

test("zoom shortcuts follow RadiAnt (Ctrl+0 fit, Ctrl+1..4 = 100..800%)", () => {
  assert.deepEqual(resolveShortcut(key("0", { ctrlKey: true, code: "Digit0" }), false), { type: "zoomTo", scale: "fit" });
  assert.deepEqual(resolveShortcut(key("3", { ctrlKey: true, code: "Digit3" }), false), { type: "zoomTo", scale: 4 });
  assert.deepEqual(resolveShortcut(key("ArrowLeft", { ctrlKey: true }), false), { type: "pan", dx: -40, dy: 0 });
});

test("digits pick presets, Shift+digits pick layouts (by code, not the shifted symbol)", () => {
  assert.deepEqual(resolveShortcut(key("4", { code: "Digit4" }), false), { type: "preset", ordinal: 4 });
  assert.deepEqual(resolveShortcut(key("0", { code: "Digit0" }), false), { type: "presetDefault" });
  assert.deepEqual(resolveShortcut(key("$", { code: "Digit4", shiftKey: true }), false), { type: "layout", rows: 2, cols: 2 });
  assert.deepEqual(resolveShortcut(key("&", { code: "Digit7", shiftKey: true }), false), { type: "layout", rows: 3, cols: 3 });
});

test("navigation and the ambiguous pairs resolve to the intended action", () => {
  assert.deepEqual(resolveShortcut(key("ArrowDown"), false), { type: "slice", delta: 1 });
  assert.deepEqual(resolveShortcut(key("PageUp"), false), { type: "slice", delta: -10 });
  assert.deepEqual(resolveShortcut(key("z", { ctrlKey: true }), false), { type: "undoAnnotation" });
  assert.deepEqual(resolveShortcut(key("Z", { ctrlKey: true, shiftKey: true }), false), { type: "open", what: "zip" });
  assert.deepEqual(resolveShortcut(key("F12", { ctrlKey: true, shiftKey: true }), false), { type: "toggleOverlay" });
  assert.deepEqual(resolveShortcut(key("F12", { ctrlKey: true }), false), { type: "toggleReferenceLines" });
  assert.deepEqual(resolveShortcut(key("F12"), false), { type: "toggleAnnotations" });
  assert.deepEqual(resolveShortcut(key("Q", { shiftKey: true }), false), { type: "rotate", degrees: -90 });
  assert.deepEqual(resolveShortcut(key("f"), false), { type: "fullscreen" });
  assert.deepEqual(resolveShortcut(key("F", { ctrlKey: true, shiftKey: true }), false), { type: "fusion" });
});

test("no two bindings claim the same key combination", () => {
  const combos = [
    ...["a", "b", "c", "d", "e", "f", "g", "h", "i", "l", "m", "o", "p", "q", "r", "v", "w", "x", "y", "z"].map((k) => key(k)),
    ...["o", "z", "m", "e", "f"].flatMap((k) => [key(k, { ctrlKey: true }), key(k, { ctrlKey: true, shiftKey: true })]),
  ];
  for (const combo of combos) {
    const matches = BINDINGS.filter((b) => b.match({ ...combo }, !!combo.ctrlKey));
    assert.ok(matches.length <= 1, `${JSON.stringify(combo)} matched ${matches.length} bindings`);
  }
  assert.ok(shortcutSheet(false).every((r) => r.keys && r.does));
});

test("orientation letters: standard axial reads A top, P bottom, R left, L right", () => {
  // Cornerstone's default axial camera.
  const e = edgeLabels([0, -1, 0], [0, 0, -1]);
  assert.deepEqual(e, { top: "A", bottom: "P", left: "R", right: "L" });
  // Coronal: head up, patient's right on screen left.
  assert.deepEqual(edgeLabels([0, 0, 1], [0, -1, 0]), { top: "H", bottom: "F", left: "R", right: "L" });
  assert.equal(directionLabel([0.7, 0.7, 0]), "LP");
  assert.equal(directionLabel([0.95, 0.1, 0]), "L");
});

const ct = (z: number, n: number, extra: Partial<DesktopHeader> = {}): DesktopHeader => ({
  fileName: `/s/IM${n}`,
  sizeBytes: 1,
  fileId: n,
  studyInstanceUID: "1.2.3",
  seriesInstanceUID: "1.2.3.4",
  modality: "CT",
  instanceNumber: n,
  imagePositionPatient: [0, 0, z],
  imageOrientationPatient: [1, 0, 0, 0, 1, 0],
  rows: 512,
  columns: 512,
  baseImageId: `wadouri:dicom://localhost/f/${n}`,
  ...extra,
});

test("axial stacks open head-first; non-axial order is untouched", () => {
  const feetFirst = [ct(-10, 1), ct(0, 2), ct(10, 3)];
  assert.deepEqual(headFirst(feetFirst).map((h) => h.imagePositionPatient![2]), [10, 0, -10]);
  const sagittal = [0, 1, 2].map((x, i) => ct(0, i, { imagePositionPatient: [x, 0, 0], imageOrientationPatient: [0, 1, 0, 0, 0, -1] }));
  assert.deepEqual(headFirst(sagittal), sagittal);
  const studies = buildStudies([ct(0, 2), ct(-10, 1), ct(10, 3)]);
  assert.deepEqual(studies[0].series[0].imageIds, ["wadouri:dicom://localhost/f/3", "wadouri:dicom://localhost/f/2", "wadouri:dicom://localhost/f/1"]);
});

test("volumetric detection: even spacing yes; gaps, mixed size, or 2 slices no", () => {
  assert.equal(isVolumetric([ct(0, 1), ct(1, 2), ct(2, 3), ct(3, 4)]), true);
  assert.equal(isVolumetric([ct(0, 1), ct(1, 2), ct(5, 3), ct(6, 4)]), false);
  assert.equal(isVolumetric([ct(0, 1), ct(1, 2), ct(2, 3, { rows: 256 })]), false);
  assert.equal(isVolumetric([ct(0, 1), ct(1, 2)]), false);
});

test("multiframe expands to one imageId per frame, and cine rate comes from the file", () => {
  const us = ct(0, 1, { modality: "US", numberOfFrames: 3, frameTime: 33.3, seriesInstanceUID: "us" });
  const [study] = buildStudies([us]);
  assert.equal(study.series[0].imageCount, 3);
  assert.equal(study.series[0].imageIds[2], "wadouri:dicom://localhost/f/1?frame=3");
  assert.equal(study.series[0].multiframe, true);
  assert.equal(frameRateOf(us), 30);
});

test("primary series prefers the largest cross-sectional stack", () => {
  const studies = buildStudies([
    ct(0, 1, { seriesInstanceUID: "scout", modality: "CT", seriesNumber: 1 }),
    ...[0, 1, 2, 3].map((z) => ct(z, 10 + z, { seriesInstanceUID: "axial", seriesNumber: 2 })),
    ...[0, 1, 2, 3, 4, 5].map((z) => ct(z, 20 + z, { seriesInstanceUID: "sr", modality: "OT", seriesNumber: 3 })),
  ]);
  assert.equal(studies[0].series[primarySeriesIndex(studies[0])].uid, "axial");
});

test("names and dates render the way a reading room expects", () => {
  assert.equal(formatPersonName("DOE^JANE^Q^^"), "DOE, JANE Q");
  assert.equal(formatPersonName("PHANTOM^CT"), "PHANTOM, CT");
  assert.equal(formatDicomDate("20240115"), "2024-01-15");
});

test("hanging keeps cells in place and fills new ones with unseen series", () => {
  assert.deepEqual(hangSeries(["b"], 4, ["a", "b", "c"]), ["b", "a", "c", null]);
  assert.deepEqual(hangSeries(["a", "b", "c", "d"], 1, ["a", "b", "c", "d"]), ["a"]);
});

test("history entries carry no patient identifiers", () => {
  const studies = buildStudies([ct(0, 1, { patientName: "DOE^JANE", patientId: "MRN123", studyDescription: "CT CHEST" })]);
  const entry = historyEntryFor({ key: sourceKey(["/b", "/a"]), paths: ["/b", "/a"], kind: "folder", label: "a" }, studies, new Date(0));
  const json = JSON.stringify(entry);
  assert.ok(!json.includes("DOE") && !json.includes("MRN123"));
  assert.equal(entry.description, "CT CHEST");
  assert.equal(entry.key, "/a|/b");
});

test("window presets are modality-aware and round-trip through VOI ranges", () => {
  assert.ok(windowPresetsFor("CT").some((p) => p.label === "Lung"));
  assert.deepEqual(windowPresetsFor("MR"), []);
  assert.deepEqual(wwwcOf(voiRangeOf(400, 40)), { ww: 400, wc: 40 });
});
