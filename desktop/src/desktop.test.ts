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
import { sanitizePetMeta } from "./viewer/suv";
import { buildMjpegAvi, exportBaseName } from "./viewer/exporter";
import { pixelStats } from "./viewer/pixelStats";
import { calculateSUVScalingFactors } from "@cornerstonejs/calculate-suv";

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
  assert.deepEqual(resolveShortcut(key("@", { code: "", shiftKey: true }), false), { type: "layout", rows: 1, cols: 2 }, "no code");
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

test("real KeyboardEvent-shaped objects (prototype getters) keep their modifiers", () => {
  class FakeKeyboardEvent {
    get key() { return "$"; }
    get code() { return "Digit4"; }
    get shiftKey() { return true; }
    get ctrlKey() { return false; }
    get metaKey() { return false; }
    get altKey() { return false; }
  }
  assert.deepEqual(resolveShortcut(new FakeKeyboardEvent() as unknown as KeyLike, false), { type: "layout", rows: 2, cols: 2 });
  class CtrlShiftO {
    get key() { return "O"; }
    get code() { return "KeyO"; }
    get shiftKey() { return true; }
    get ctrlKey() { return true; }
    get metaKey() { return false; }
    get altKey() { return false; }
  }
  assert.deepEqual(resolveShortcut(new CtrlShiftO() as unknown as KeyLike, false), { type: "open", what: "folder" });
});

test("SUVbw computes for PatientSex 'O' and absent optional tags", () => {
  const meta = sanitizePetMeta({
    CorrectedImage: ["ATTN", "DECY"], Units: "BQML", RadionuclideHalfLife: 6586.2, RadionuclideTotalDose: 370000000,
    DecayCorrection: "START", PatientWeight: 75, PatientSize: 1.75, PatientSex: "O", SeriesDate: "20240115",
    SeriesTime: "100000.00", AcquisitionDate: "20240115", AcquisitionTime: "100000.00",
    RadiopharmaceuticalStartTime: "090000.00", RadiopharmaceuticalStartDateTime: null, FrameReferenceTime: null,
  });
  assert.equal("PatientSex" in meta, false);
  assert.equal("FrameReferenceTime" in meta, false);
  const [r] = calculateSUVScalingFactors([meta] as never);
  // 75 kg, 370 MBq, 1 h after injection, F-18: suvbw ≈ 75000 / (370e6 · 2^(-3600/6586.2)).
  const expected = 75000 / (370e6 * Math.pow(2, -3600 / 6586.2));
  assert.ok(Math.abs(r.suvbw - expected) / expected < 1e-3, `${r.suvbw} vs ${expected}`);
});

test("MJPEG AVI container: RIFF sizes, frame count, index offsets", () => {
  const frames = [new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]), new Uint8Array([0xff, 0xd8, 2, 3, 0xff, 0xd9])];
  const avi = buildMjpegAvi(frames, 64, 48, 15);
  const dv = new DataView(avi.buffer);
  const tag = (o: number) => String.fromCharCode(...avi.slice(o, o + 4));
  assert.equal(tag(0), "RIFF");
  assert.equal(dv.getUint32(4, true), avi.byteLength - 8);
  assert.equal(tag(8), "AVI ");
  // avih: total frames, width, height
  assert.equal(dv.getUint32(32 + 16, true), 2);
  assert.equal(dv.getUint32(32 + 32, true), 64);
  assert.equal(dv.getUint32(32 + 36, true), 48);
  const movi = [...avi.keys()].find((i) => tag(i) === "movi")!;
  const idx = [...avi.keys()].find((i) => tag(i) === "idx1")!;
  assert.equal(tag(idx + 8), "00dc");
  const firstOffset = dv.getUint32(idx + 16, true);
  assert.equal(tag(movi + firstOffset), "00dc");
  assert.equal(dv.getUint32(movi + firstOffset + 4, true), 5);
  const secondOffset = dv.getUint32(idx + 32, true);
  assert.equal(tag(movi + secondOffset), "00dc", "odd-length frame is padded");
});

test("export file names never carry patient text", () => {
  const name = exportBaseName({ modality: "CT", seriesNumber: 2 }, new Date(2026, 0, 2, 3, 4, 5));
  assert.equal(name, "CT_se2_20260102-030405");
});

test("PET/CT hangs the CT first even when the PET has more slices", () => {
  const studies = buildStudies([
    ...[0, 1, 2].map((z) => ct(z, 30 + z, { seriesInstanceUID: "ct", modality: "CT", seriesNumber: 3 })),
    ...[0, 1, 2, 3, 4].map((z) => ct(z, 40 + z, { seriesInstanceUID: "pt", modality: "PT", seriesNumber: 4 })),
  ]);
  assert.equal(studies[0].series[primarySeriesIndex(studies[0])].uid, "ct");
});

test("pixel stats for the codec check: exact integer sum, min, max, count", () => {
  assert.deepEqual(pixelStats(new Int16Array([-1024, 0, 40, 3071])), { count: 4, min: -1024, max: 3071, sum: 2087 });
  assert.deepEqual(pixelStats(new Uint8Array([7])), { count: 1, min: 7, max: 7, sum: 7 });
});
