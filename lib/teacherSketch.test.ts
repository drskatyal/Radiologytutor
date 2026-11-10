import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fitScaleFor,
  fractionToIndex,
  frameFromCamera,
  indexToFraction,
  indexToPatient,
  indexToScoord,
  patientToIndex,
  scoordToIndex,
  type DicomImagePlane,
  type SketchFrameImage,
  type StackCamera,
} from "./sketchProjection.ts";
import {
  anchorPoint,
  applySketchOp,
  cleanSketchItem,
  commitSketchOp,
  EMPTY_HISTORY,
  hitTestSketch,
  imageRefFrom,
  inverseSketchOp,
  itemOnImage,
  linkSketchesToNarration,
  nextMarkerNumber,
  redoSketch,
  revealedPoints,
  sketchClockLines,
  sketchItemsAt,
  sketchItemsOf,
  sketchTimeline,
  strokeProgress,
  teacherMarkerInWindow,
  undoSketch,
  withSketchAnnotations,
} from "./teacherSketch.ts";
import { resolveStudioHotkey, STUDENT_SESSION_KEYS, STUDIO_MARKER_KEY, STUDIO_TOOL_KEYS } from "./studioHotkeys.ts";
import { resolveViewerHotkey } from "./viewerHotkeys.ts";
import { trackClockSummary } from "./compileMedia.ts";
import { compileStructuredSession, type CompileGenerate } from "./compileSession.ts";
import { mergeCaptureDemonstration } from "./harness/mergeCapture.ts";
import { guideForFindingTrack } from "./teachingGuide.ts";
import { buildLiveSketch, resolveSketchTool } from "./sketchMarks.ts";
import { materializeLiveTeachingPack } from "./liveTeachingPack.ts";
import { startReplay } from "./replay.ts";
import type { Finding, RecordedEvent, RecordedTrack, TeacherSketchItem, TeacherSketchOp } from "./types.ts";

// An oblique, anisotropic plane: catches row/column spacing or cosine swaps.
const OBLIQUE: DicomImagePlane = {
  imagePositionPatient: [-120.5, 88.25, -301.75],
  rowCosines: [Math.cos(0.3), Math.sin(0.3), 0],
  columnCosines: [-Math.sin(0.3) * Math.cos(0.2), Math.cos(0.3) * Math.cos(0.2), -Math.sin(0.2)],
  pixelSpacing: [0.7, 0.55],
  columns: 512,
  rows: 400,
};

const IMAGE: SketchFrameImage = {
  sliceIndex: 6,
  studyInstanceUID: "1.2.3",
  seriesInstanceUID: "1.2.3.4",
  sopInstanceUID: "1.2.3.4.6",
  sopClassUID: "1.2.840.10008.5.1.4.1.1.2",
  frameOfReferenceUID: "1.2.3.9",
  columns: 512,
  rows: 400,
  plane: OBLIQUE,
};

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// ---------------------------------------------------------------------------
// Projection round-trips
// ---------------------------------------------------------------------------

test("fraction ↔ pixel index ↔ patient mm round-trip on an oblique, anisotropic plane", () => {
  for (const [x, y] of [[0, 0], [1, 1], [0.3125, 0.71], [0.5, 0.5], [0.999, 0.001]] as const) {
    const idx = fractionToIndex(x, y, 512, 400)!;
    const back = indexToFraction(idx.col, idx.row, 512, 400)!;
    close(back.x_pct, x);
    close(back.y_pct, y);
    const mm = indexToPatient(idx.col, idx.row, OBLIQUE)!;
    const again = patientToIndex(mm, OBLIQUE)!;
    close(again.col, idx.col, 1e-9);
    close(again.row, idx.row, 1e-9);
  }
});

test("patient mm follows DICOM: column steps use PixelSpacing[1] along the row cosine", () => {
  const origin = indexToPatient(0, 0, OBLIQUE)!;
  assert.deepEqual(origin, OBLIQUE.imagePositionPatient);
  const oneCol = indexToPatient(1, 0, OBLIQUE)!;
  const oneRow = indexToPatient(0, 1, OBLIQUE)!;
  close(Math.hypot(oneCol[0] - origin[0], oneCol[1] - origin[1], oneCol[2] - origin[2]), 0.55);
  close(Math.hypot(oneRow[0] - origin[0], oneRow[1] - origin[1], oneRow[2] - origin[2]), 0.7);
});

test("SCOORD puts 0,0 at the first pixel's corner; index puts it at the centre", () => {
  assert.deepEqual(indexToScoord(0, 0), [0.5, 0.5]);
  assert.deepEqual(scoordToIndex(511.5, 399.5), { col: 511, row: 399 });
});

test("an anchored point stays on the same pixels through zoom, pan, and a resized canvas", () => {
  const point = anchorPoint(0.62, 0.37, IMAGE);
  assert.equal(point.col, 0.62 * 511);
  assert.equal(point.row, 0.37 * 399);
  assert.ok(point.mm);
  const cameras: StackCamera[] = [
    { columns: 512, rows: 400, canvasWidth: 800, canvasHeight: 600, fitScale: fitScaleFor(512, 400, 800, 600), zoom: 1, panX: 0, panY: 0 },
    { columns: 512, rows: 400, canvasWidth: 800, canvasHeight: 600, fitScale: fitScaleFor(512, 400, 800, 600), zoom: 3.2, panX: -140, panY: 75 },
    { columns: 512, rows: 400, canvasWidth: 390, canvasHeight: 700, fitScale: fitScaleFor(512, 400, 390, 700), zoom: 1.7, panX: 22, panY: -9 },
  ];
  const screens = cameras.map((camera) => {
    const frame = frameFromCamera(camera, 6);
    const screen = frame.project(point.x_pct, point.y_pct)!;
    const back = frame.unproject(screen.x, screen.y)!;
    close(back.x_pct, point.x_pct, 1e-9);
    close(back.y_pct, point.y_pct, 1e-9);
    return screen;
  });
  // The screen point moved; the image point did not.
  assert.notDeepEqual(screens[0], screens[1]);
});

test("a stroke shows on its own image only, and an old (UID-less) stroke still matches by slice", () => {
  const item: TeacherSketchItem = { id: "a", kind: "pen", image: imageRefFrom(IMAGE, 6), points: [] };
  assert.equal(itemOnImage(item, { sliceIndex: 6, sopInstanceUID: "1.2.3.4.6", seriesInstanceUID: "1.2.3.4" }), true);
  assert.equal(itemOnImage(item, { sliceIndex: 7, sopInstanceUID: "1.2.3.4.7", seriesInstanceUID: "1.2.3.4" }), false);
  // A re-sorted stack moves the index; the SOP still wins.
  assert.equal(itemOnImage(item, { sliceIndex: 9, sopInstanceUID: "1.2.3.4.6" }), true);
  assert.equal(itemOnImage(item, { sliceIndex: 6, seriesInstanceUID: "9.9" }), false);
  const multi: TeacherSketchItem = { ...item, image: { ...item.image, frameNumber: 3 } };
  assert.equal(itemOnImage(multi, { sliceIndex: 6, sopInstanceUID: "1.2.3.4.6", frameNumber: 4 }), false);
  const legacy: TeacherSketchItem = { id: "b", kind: "pen", image: { sliceIndex: 2 }, points: [] };
  assert.equal(itemOnImage(legacy, { sliceIndex: 2, sopInstanceUID: "x" }), true);
  assert.equal(itemOnImage(legacy, { sliceIndex: 3 }), false);
});

// ---------------------------------------------------------------------------
// Reducer, undo / redo, markers
// ---------------------------------------------------------------------------

function pen(id: string, slice = 6, drawMs = 400): TeacherSketchItem {
  return {
    id,
    kind: "pen",
    image: { ...imageRefFrom(IMAGE, slice) },
    points: [
      anchorPoint(0.1, 0.1, IMAGE, 0),
      anchorPoint(0.2, 0.15, IMAGE, 200),
      anchorPoint(0.3, 0.1, IMAGE, 400),
    ],
    drawMs,
  };
}

function marker(id: string, n: number, x = 0.62, y = 0.37, slice = 6): TeacherSketchItem {
  return { id, kind: "marker", image: imageRefFrom({ ...IMAGE, sliceIndex: slice }, slice), points: [anchorPoint(x, y, IMAGE)], number: n, text: `Finding ${n}` };
}

test("undo and redo are inverse ops, and every move is a recordable op", () => {
  let h = EMPTY_HISTORY;
  const applied: TeacherSketchOp[] = [];
  const run = (r: { history: typeof h; applied: TeacherSketchOp | null }) => {
    h = r.history;
    if (r.applied) applied.push(r.applied);
  };
  run(commitSketchOp(h, { op: "add", item: pen("p1") }));
  run(commitSketchOp(h, { op: "add", item: marker("m1", 1) }));
  run(commitSketchOp(h, { op: "label", id: "m1", text: "Apical nodule" }));
  run(commitSketchOp(h, { op: "remove", id: "p1" }));
  assert.deepEqual(h.items.map((i) => i.id), ["m1"]);
  run(undoSketch(h)); // restores p1
  assert.deepEqual(h.items.map((i) => i.id).sort(), ["m1", "p1"]);
  run(undoSketch(h)); // label back
  assert.equal(h.items.find((i) => i.id === "m1")?.text, "Finding 1");
  run(redoSketch(h));
  assert.equal(h.items.find((i) => i.id === "m1")?.text, "Apical nodule");
  // Folding the recorded ops reproduces the live state.
  const folded = applied.reduce<TeacherSketchItem[]>((items, op) => applySketchOp(items, op), []);
  assert.deepEqual(folded.map((i) => [i.id, i.text]).sort(), h.items.map((i) => [i.id, i.text]).sort());
  assert.equal(inverseSketchOp([], { op: "remove", id: "nope" }), null);
});

test("marker numbers count up from the highest still on the image", () => {
  assert.equal(nextMarkerNumber([]), 1);
  assert.equal(nextMarkerNumber([marker("a", 1), marker("b", 4), pen("p")]), 5);
});

// ---------------------------------------------------------------------------
// Timeline, progressive replay, narration links
// ---------------------------------------------------------------------------

function sketchEvent(t: number, op: TeacherSketchOp): RecordedEvent {
  return { t, type: "sketch", ...op } as RecordedEvent;
}

const TAKE: RecordedTrack = {
  durationMs: 9000,
  start: { sliceIndex: 4 },
  narration: [
    { tStartMs: 0, tEndMs: 2500, text: "Start at the apex." },
    { tStartMs: 2600, tEndMs: 6000, text: "Here is a spiculated nodule in the left upper lobe." },
    { tStartMs: 6200, tEndMs: 9000, text: "Compare the hilum." },
  ],
  events: [
    { t: 400, type: "slice", index: 6 },
    { t: 900, type: "cursor", x: 0.5, y: 0.5 },
    sketchEvent(1000, { op: "add", item: pen("p1") }),
    sketchEvent(3100, { op: "add", item: marker("m1", 1) }),
    sketchEvent(3600, { op: "label", id: "m1", text: "Spiculated nodule" }),
    sketchEvent(4000, {
      op: "add",
      item: { id: "e1", kind: "ellipse", image: imageRefFrom(IMAGE, 6), points: [anchorPoint(0.55, 0.3, IMAGE, 0), anchorPoint(0.7, 0.44, IMAGE, 300)], drawMs: 300 },
    }),
    sketchEvent(4500, {
      op: "add",
      item: { id: "a1", kind: "arrow", image: imageRefFrom(IMAGE, 6), points: [anchorPoint(0.85, 0.6, IMAGE, 0), anchorPoint(0.64, 0.39, IMAGE, 250)], drawMs: 250 },
    }),
    sketchEvent(5000, { op: "remove", id: "p1" }),
    { t: 6500, type: "slice", index: 9 },
    sketchEvent(7000, { op: "add", item: marker("m2", 2, 0.4, 0.5, 9) }),
  ],
};

test("progressive replay folds ops in time and draws a pen back at its own speed", () => {
  assert.deepEqual(sketchItemsAt(TAKE.events, 900).map((p) => p.item.id), []);
  assert.deepEqual(sketchItemsAt(TAKE.events, 3200).map((p) => p.item.id), ["p1", "m1"]);
  assert.equal(sketchItemsAt(TAKE.events, 3700).find((p) => p.item.id === "m1")?.item.text, "Spiculated nodule");
  assert.deepEqual(sketchItemsAt(TAKE.events, 5000).map((p) => p.item.id), ["m1", "e1", "a1"]);
  const stroke = pen("p1");
  assert.equal(revealedPoints(stroke, 0).length, 1);
  assert.equal(revealedPoints(stroke, 210).length, 2);
  assert.equal(revealedPoints(stroke, 400).length, 3);
  assert.equal(strokeProgress(stroke, 200), 0.5);
  assert.deepEqual(sketchItemsOf(TAKE).map((i) => i.id), ["m1", "e1", "a1", "m2"]);
});

test("each mark links to the sentence it was drawn under; the compile clock lists markers without coordinates", () => {
  const links = linkSketchesToNarration(TAKE.events, TAKE.narration);
  const m1 = links.find((l) => l.id === "m1")!;
  assert.equal(m1.spanIndex, 1);
  assert.match(m1.said!, /spiculated nodule/);
  assert.equal(m1.label, "Spiculated nodule");
  assert.equal(links.find((l) => l.id === "p1")?.kept, false);
  const clock = trackClockSummary(TAKE);
  assert.match(clock, /t=3100ms marker #1 "Spiculated nodule" \(slice 6\)/);
  assert.match(clock, /t=7000ms marker #2/);
  assert.doesNotMatch(clock, /0\.62|0\.37/);
  assert.equal(sketchClockLines(TAKE.events).some((line) => line.includes("pen")), false); // erased
  assert.equal(sketchTimeline(TAKE.events).length, 5);
});

test("a finding landing prefers the teacher's numbered marker over a cursor sample", async () => {
  const pinned = teacherMarkerInWindow(TAKE, 2600, 6000)!;
  assert.equal(pinned.label, "Spiculated nodule");
  assert.deepEqual(pinned.marker, { x_pct: 0.62, y_pct: 0.37, shape: "circle" });
  assert.equal(pinned.sopInstanceUID, "1.2.3.4.6");
  assert.equal(teacherMarkerInWindow(TAKE, 0, 1500), null);

  const generate: CompileGenerate = async () => ({
    text: JSON.stringify({
      transcript: "…",
      findings: [
        { label: "", description: "Nodule", teachingPoints: [], tStartMs: 2600, tEndMs: 6000, x_pct: 0.1, y_pct: 0.1 },
        { label: "Hilum", description: "", teachingPoints: [], tStartMs: 6200, tEndMs: 9000 },
      ],
    }),
  });
  const session = await compileStructuredSession({ transcript: "…", durationMs: 9000, track: TAKE }, generate);
  assert.equal(session.findings[0]?.label, "Spiculated nodule");
  assert.deepEqual(session.findings[0]?.suggestedMarker, { x_pct: 0.62, y_pct: 0.37, shape: "circle" });
  assert.equal(session.findings[0]?.suggestedSliceIndex, 6);
  assert.equal(session.findings[1]?.suggestedSliceIndex, 9);

  const merged = mergeCaptureDemonstration({ sessionId: "cap", parentTrack: TAKE, segments: session.findings });
  assert.equal(merged.findings[0]?.sopInstanceUID, "1.2.3.4.6");
  assert.equal(merged.findings[1]?.marker?.x_pct, 0.4);
});

test("teacher arrows and ellipses become the guide's annotate beats", () => {
  const derived = withSketchAnnotations(TAKE);
  const ann = derived.events.filter((e) => e.type === "annotation");
  assert.deepEqual(ann.map((e) => (e as { tool?: string }).tool), ["EllipticalROI", "ArrowAnnotate"]);
  assert.equal(TAKE.events.some((e) => e.type === "annotation"), false, "source track is not mutated");
  const guide = guideForFindingTrack(TAKE, { description: "Spiculated nodule.", teachingPoints: [] });
  const annotate = guide.beats.flatMap((b) => b.actions).filter((a) => a.type === "annotate");
  assert.ok(annotate.length >= 1);
});

test("the AI sketch tool redraws the teacher's own ellipse and arrow, and still refuses an invented point", () => {
  const sub: RecordedTrack = { ...TAKE, events: TAKE.events.filter((e) => e.t <= 5000) };
  const finding: Finding = {
    id: "f1",
    label: "Spiculated nodule",
    description: "",
    teachingPoints: [],
    state: " ",
    marker: { x_pct: 0.62, y_pct: 0.37, shape: "circle" },
    order: 1,
    sliceIndex: 6,
    track: sub,
  };
  const anchor = buildLiveSketch(finding)!;
  close(anchor.ellipse!.rx, 0.075);
  close(anchor.ellipse!.ry, 0.07);
  assert.equal(anchor.arrow.authored, true);
  assert.deepEqual(anchor.arrow.from, { x_pct: 0.85, y_pct: 0.6 });

  const pack = materializeLiveTeachingPack({ caseId: "c", modality: "CT", findings: [finding] });
  const id = pack.findings[0]!.id;
  const ok = resolveSketchTool(pack, "draw_arrow", { findingId: id });
  assert.equal(ok.ok, true);
  const bad = resolveSketchTool(pack, "draw_circle", { findingId: id, x_pct: 0.2, y_pct: 0.2 });
  assert.equal(bad.ok, false);
});

test("replay: old recordings never touch the sketch sink; new ones reset then draw in order", () => {
  let now = 0;
  const queue: Array<(t: number) => void> = [];
  const g = globalThis as unknown as {
    performance: { now: () => number };
    requestAnimationFrame: (cb: (t: number) => void) => number;
    cancelAnimationFrame: (id: number) => void;
  };
  const saved = { performance: g.performance, raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
  g.performance = { now: () => now } as typeof g.performance;
  g.requestAnimationFrame = (cb) => queue.push(cb);
  g.cancelAnimationFrame = () => {};
  const flush = (ms: number) => {
    now = ms;
    for (const cb of queue.splice(0)) cb(now);
  };
  try {
    const legacy: RecordedTrack = { durationMs: 500, start: { sliceIndex: 0 }, events: [{ t: 100, type: "slice", index: 1 }] };
    const seenLegacy: string[] = [];
    startReplay(legacy, { applyEvent: () => {}, getStartState: () => ({ sliceIndex: 0 }) }, { overlay: { sketch: (e) => seenLegacy.push(e.op) } });
    flush(600);
    assert.deepEqual(seenLegacy, []);

    now = 0;
    const seen: string[] = [];
    const applied: string[] = [];
    startReplay(
      TAKE,
      { applyEvent: (e) => applied.push(e.type), getStartState: () => ({ sliceIndex: 0 }) },
      { overlay: { sketch: (e) => seen.push(e.op === "add" ? `add:${e.item.id}` : e.op) } }
    );
    assert.deepEqual(seen, ["reset"]);
    flush(3200);
    assert.deepEqual(seen, ["reset", "add:p1", "add:m1"]);
    flush(9500);
    assert.deepEqual(seen, ["reset", "add:p1", "add:m1", "label", "add:e1", "add:a1", "remove", "add:m2"]);
    assert.equal(applied.includes("sketch"), false, "sketch ops never reach the viewer");
  } finally {
    g.performance = saved.performance;
    g.requestAnimationFrame = saved.raf;
    g.cancelAnimationFrame = saved.caf;
  }
});

// ---------------------------------------------------------------------------
// Eraser + validation
// ---------------------------------------------------------------------------

test("the eraser hits the topmost mark on this image within tolerance", () => {
  const camera: StackCamera = { columns: 512, rows: 400, canvasWidth: 800, canvasHeight: 600, fitScale: fitScaleFor(512, 400, 800, 600), zoom: 2, panX: 0, panY: 0 };
  const frame = frameFromCamera(camera, 6);
  const items = [pen("p1"), marker("m1", 1)];
  const view = { sliceIndex: 6, sopInstanceUID: "1.2.3.4.6" };
  const onPen = frame.project(0.2, 0.15)!;
  assert.equal(hitTestSketch(items, view, frame.project, onPen.x + 3, onPen.y, 10)?.id, "p1");
  const onMarker = frame.project(0.62, 0.37)!;
  assert.equal(hitTestSketch(items, view, frame.project, onMarker.x, onMarker.y)?.id, "m1");
  assert.equal(hitTestSketch(items, { sliceIndex: 7, sopInstanceUID: "other" }, frame.project, onMarker.x, onMarker.y), null);
  assert.equal(hitTestSketch(items, view, frame.project, 5, 5), null);
});

test("untrusted items are validated: bad kinds, ids, and UIDs are dropped; text is plain", () => {
  assert.equal(cleanSketchItem({ id: "x", kind: "laser", image: { sliceIndex: 1 }, points: [{ x_pct: 0, y_pct: 0 }] }), null);
  assert.equal(cleanSketchItem({ id: "<x>", kind: "marker", image: { sliceIndex: 1 }, points: [{ x_pct: 0, y_pct: 0 }] }), null);
  const item = cleanSketchItem({
    id: "t1",
    kind: "text",
    image: { sliceIndex: 2, sopInstanceUID: "1.2.3", seriesInstanceUID: "drop me; DROP TABLE" },
    points: [{ x_pct: 0.5, y_pct: 0.5, col: 10, row: 11, mm: [1, 2, 3] }],
    text: "<b>Look</b> here",
  })!;
  assert.equal(item.image.seriesInstanceUID, undefined);
  assert.equal(item.image.sopInstanceUID, "1.2.3");
  assert.equal(item.text, "bLook/b here");
  assert.deepEqual(item.points[0], { x_pct: 0.5, y_pct: 0.5, col: 10, row: 11, mm: [1, 2, 3] });
});

// ---------------------------------------------------------------------------
// Studio hotkeys
// ---------------------------------------------------------------------------

test("Studio sketch keys never reuse a student-session key, and Alt+X stays with recording", () => {
  const studio = [...Object.keys(STUDIO_TOOL_KEYS), STUDIO_MARKER_KEY, "u"];
  for (const key of studio) {
    assert.equal((STUDENT_SESSION_KEYS as readonly string[]).includes(key), false, `${key} clashes with the student session`);
  }
  assert.equal(resolveStudioHotkey({ key: "x", altKey: true }), null);
  assert.equal(resolveStudioHotkey({ key: "m", altKey: true }), null);
  assert.deepEqual(resolveStudioHotkey({ key: "M" }), { type: "marker" });
  assert.deepEqual(resolveStudioHotkey({ key: "d" }), { type: "tool", tool: "pen" });
  assert.deepEqual(resolveStudioHotkey({ key: "o" }), { type: "tool", tool: "ellipse" });
  assert.deepEqual(resolveStudioHotkey({ key: "q" }), { type: "tool", tool: "text" });
  assert.deepEqual(resolveStudioHotkey({ key: "e" }), { type: "tool", tool: "eraser" });
  assert.deepEqual(resolveStudioHotkey({ key: "Escape" }), { type: "tool", tool: "select" });
  assert.deepEqual(resolveStudioHotkey({ key: "z", metaKey: true }), { type: "undo" });
  assert.deepEqual(resolveStudioHotkey({ key: "Z", ctrlKey: true, shiftKey: true }), { type: "redo" });
  assert.equal(resolveStudioHotkey({ key: "c" }), null);
  assert.equal(resolveStudioHotkey({ key: "p" }), null);
  assert.equal(resolveStudioHotkey({ key: "t" }), null);
  // Digits still reach the viewer: they are window presets there now (4 = the
  // preset menu's fourth entry), as on the desktop. Pan stays on the toolbar.
  assert.equal(resolveStudioHotkey({ key: "4" }), null);
  assert.deepEqual(resolveViewerHotkey({ key: "4" }), { type: "preset", ordinal: 4 });
});
