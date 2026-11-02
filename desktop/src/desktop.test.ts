// Pure renderer logic. Run: npm --prefix desktop test
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveShortcut, shortcutSheet, BINDINGS, keySpecOf, conflictFor, type KeyLike } from "./shortcuts";
import { edgeLabels, directionLabel } from "./viewer/orientation";
import { buildStudies, headFirst, isVolumetric, formatPersonName, formatDicomDate, frameRateOf, primarySeriesIndex } from "./study";
import { hangSeries } from "./layout";
import { historyEntryFor, sourceKey } from "./history";
import { windowPresetsFor, voiRangeOf, wwwcOf } from "./viewer/presets";
import type { DesktopHeader } from "./types";
import { sanitizePetMeta } from "./viewer/suv";
import { buildMjpegAvi, exportBaseName } from "./viewer/exporter";
import { pixelStats } from "./viewer/pixelStats";
import { withKeyImageSeries, reportsFor, type DicomDocument } from "./documents";
import { calculateSUVScalingFactors } from "@cornerstonejs/calculate-suv";

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({ key: k, ...extra });

test("tool letters: W window, Z zoom, P pan, M measure (and RadiAnt's B, L, A, C, E, Y)", () => {
  const map: Record<string, string> = { b: "StackScroll", w: "WindowLevel", p: "Pan", z: "Zoom", m: "Length", l: "Length", a: "Angle", c: "CobbAngle", e: "EllipticalROI", y: "ArrowAnnotate", n: "PlanarFreehandROI" };
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
  assert.deepEqual(resolveShortcut(key("PageUp"), false), { type: "slicePage", dir: -1 });
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

test("navigation (RadiAnt): up/down slices, left/right series, PgUp/PgDn 10%, Tab and [ ] series", () => {
  assert.deepEqual(resolveShortcut(key("ArrowDown"), false), { type: "slice", delta: 1 });
  assert.deepEqual(resolveShortcut(key("ArrowUp"), false), { type: "slice", delta: -1 });
  assert.deepEqual(resolveShortcut(key("ArrowRight"), false), { type: "series", delta: 1 });
  assert.deepEqual(resolveShortcut(key("ArrowLeft"), false), { type: "series", delta: -1 });
  assert.deepEqual(resolveShortcut(key("PageDown"), false), { type: "slicePage", dir: 1 });
  assert.deepEqual(resolveShortcut(key("PageUp"), false), { type: "slicePage", dir: -1 });
  assert.deepEqual(resolveShortcut(key("Home"), false), { type: "sliceEdge", where: "first" });
  assert.deepEqual(resolveShortcut(key("End"), false), { type: "sliceEdge", where: "last" });
  assert.deepEqual(resolveShortcut(key("Tab"), false), { type: "series", delta: 1 });
  assert.deepEqual(resolveShortcut(key("Tab", { shiftKey: true }), false), { type: "series", delta: -1 });
  assert.deepEqual(resolveShortcut(key("]"), false), { type: "series", delta: 1 });
  assert.deepEqual(resolveShortcut(key("["), false), { type: "series", delta: -1 });
  assert.deepEqual(resolveShortcut(key("}", { shiftKey: true }), false), { type: "cineFps", delta: 5 });
  assert.deepEqual(resolveShortcut(key("?", { shiftKey: true }), false), { type: "help" });
  assert.deepEqual(resolveShortcut(key("Escape"), false), { type: "escape" });
});

test("local study database: every query word must match some field, accent- and case-insensitive", async () => {
  const { searchHistory } = await import("./history");
  const base = { kind: "folder" as const, studyCount: 1, seriesCount: 3, imageCount: 300, openedAt: "2026-11-01T00:00:00Z" };
  const entries = [
    { ...base, key: "a", paths: ["/cd/ct"], label: "ct", description: "CT CHEST", studyDate: "20260115", modalities: ["CT"],
      seriesDescriptions: ["Lung 1.0", "Mediastinum 3.0"], bodyParts: ["CHEST"], accession: "ACC123",
      patient: { name: "MÜLLER^JOSÉ", id: "P-77" } },
    { ...base, key: "b", paths: ["/usb/brain"], label: "brain", description: "MR BRAIN", studyDate: "20250301", modalities: ["MR"],
      seriesDescriptions: ["t2_flair_tra"] },
  ];
  const keys = (q: string) => searchHistory(entries, q).map((e) => e.key);
  assert.deepEqual(keys(""), ["a", "b"]);
  assert.deepEqual(keys("muller jose"), ["a"]); // patient name, accents and ^ folded
  assert.deepEqual(keys("p-77"), ["a"]);
  assert.deepEqual(keys("2026-01-15"), ["a"]);
  assert.deepEqual(keys("flair"), ["b"]); // series description
  assert.deepEqual(keys("ct lung"), ["a"]);
  assert.deepEqual(keys("ct flair"), []); // all words must match one study
  assert.deepEqual(keys("acc123"), ["a"]);
});

test("key-image notes become a KO series of exactly the referenced images; SRs list per study", () => {
  const studies = buildStudies([1, 2, 3].map((n) => ct(n * 5, n, { sopInstanceUID: `sop.${n}` })));
  const doc = (kind: "sr" | "ko", refs: string[], study = "1.2.3"): DicomDocument => ({
    kind, fileName: `/s/${kind}`, studyInstanceUid: study, sopInstanceUid: `${kind}.1`, title: kind === "ko" ? "Key images" : "Report", lines: ["x"], references: refs,
  });
  const ko = doc("ko", ["sop.3", "sop.1", "missing"]);
  const sr = doc("sr", ["sop.2"]);
  const [study] = withKeyImageSeries(studies, [ko, sr, doc("ko", ["sop.1"], "other.study")]);
  assert.equal(study.series.length, 2, "one KO series added, the other-study note ignored");
  const kos = study.series[0];
  assert.equal(kos.modality, "KO");
  assert.equal(kos.imageCount, 2);
  assert.deepEqual(kos.headers.map((h) => h.sopInstanceUID), ["sop.3", "sop.1"], "note order kept");
  assert.equal(withKeyImageSeries(studies, [sr]), studies, "no notes: unchanged");
  assert.deepEqual(reportsFor(study, [ko, sr]), [sr]);
});

test("shortcut labels: words on Windows/Linux (no ⇧ ⌥ ⌫ that render as '?'), glyphs on macOS", async () => {
  const { keyLabel } = await import("./shortcuts");
  assert.equal(keyLabel("Shift+Q", false), "Shift+Q");
  assert.equal(keyLabel("Mod+Shift+M", false), "Ctrl+Shift+M");
  assert.equal(keyLabel("Mod+Alt+O", false), "Ctrl+Alt+O");
  assert.equal(keyLabel("Mod+Shift+Backspace", false), "Ctrl+Shift+Backspace");
  assert.equal(keyLabel("Mod+Shift+M", true), "⌘⇧M");
  for (const spec of ["Shift+Q", "Mod+Shift+M", "Mod+Alt+O", "Mod+Shift+Backspace", "Mod+Shift+F12"]) {
    assert.doesNotMatch(keyLabel(spec, false), /[⇧⌥⌫⌘]/, spec);
  }
});

test("reformat and slab shortcuts: Alt+C/S/A, T, Ctrl+[ ]", () => {
  assert.deepEqual(resolveShortcut(key("c", { altKey: true, code: "KeyC" }), false), { type: "reformat", plane: "coronal" });
  assert.deepEqual(resolveShortcut(key("ß", { altKey: true, code: "KeyS" }), true), { type: "reformat", plane: "sagittal" }, "macOS Option letter");
  assert.deepEqual(resolveShortcut(key("a", { altKey: true, code: "KeyA" }), false), { type: "reformat", plane: "axial" });
  assert.deepEqual(resolveShortcut(key("t"), false), { type: "slabCycle" });
  assert.deepEqual(resolveShortcut(key("]", { ctrlKey: true, code: "BracketRight" }), false), { type: "slabThickness", deltaMm: 2 });
  assert.deepEqual(resolveShortcut(key("[", { ctrlKey: true, code: "BracketLeft" }), false), { type: "slabThickness", deltaMm: -2 });
});

test("re-mapped shortcuts: the new key fires, the default no longer does, clashes are found", () => {
  const overrides = { "tool.w": "Shift+W", "series.next": "Mod+Alt+ArrowRight" };
  assert.deepEqual(resolveShortcut(key("W", { shiftKey: true, code: "KeyW" }), false, overrides), { type: "tool", tool: "WindowLevel" });
  assert.equal(resolveShortcut(key("w", { code: "KeyW" }), false, overrides), null, "default released");
  assert.deepEqual(resolveShortcut(key("ArrowRight", { ctrlKey: true, altKey: true }), false, overrides), { type: "series", delta: 1 });
  assert.equal(keySpecOf(key("k", { ctrlKey: true, shiftKey: true, code: "KeyK" }), false), "Mod+Shift+K");
  assert.equal(keySpecOf(key("4", { metaKey: true, code: "Digit4" }), true), "Mod+4");
  assert.equal(keySpecOf(key("Shift", { shiftKey: true }), false), null, "modifier alone");
  assert.equal(conflictFor("Z", "tool.w", {}, false)?.action.type, "tool", "Z is zoom");
  assert.equal(conflictFor("Shift+3", "tool.w", {}, false)?.action.type, "layout", "range bindings claim their keys");
  assert.equal(conflictFor("Mod+Shift+K", "tool.w", {}, false), null);
  assert.equal(conflictFor("Shift+W", "invert", overrides, false)?.id, "tool.w", "re-mapped keys are claimed");
  assert.ok(shortcutSheet(false, overrides).some((r) => r.custom && r.keys === "Shift+W"));
});

test("files with the same name in two series keep their own headers (browser drop of two folders)", () => {
  // Same file names, different series: the 1 mm stack must stay 1 mm (and volumetric).
  const thin = [0, 1, 2, 3].map((i) => ct(0 - i || 0, i + 1, { fileName: `IM${i + 1}`, seriesInstanceUID: "thin", fileId: i }));
  const thick = [0, 1].map((i) => ct(-5 * i - 0.5, i + 1, { fileName: `IM${i + 1}`, seriesInstanceUID: "thick", fileId: 10 + i }));
  const [study] = buildStudies([...thin, ...thick]);
  const byUid = new Map(study.series.map((s) => [s.uid, s]));
  assert.deepEqual(byUid.get("thin")!.headers.map((h) => h.imagePositionPatient![2]), [0, -1, -2, -3]);
  assert.equal(byUid.get("thin")!.volumetric, true);
  assert.deepEqual(byUid.get("thick")!.headers.map((h) => h.imagePositionPatient![2]), [-0.5, -5.5]);
});
