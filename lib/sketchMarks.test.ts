import { test } from "node:test";
import assert from "node:assert/strict";
import { materializeLiveTeachingPack, validateLiveToolCall } from "./liveTeachingPack.ts";
import {
  fillDiagramCard,
  markVisibleOnSlice,
  plainTeachingText,
  replaySketches,
  resolveSketchTool,
  uncertainTapMark,
} from "./sketchMarks.ts";
import {
  cardPixelSize,
  frameFromCamera,
  imageFractionToWorld,
  leaderStart,
  placeCardBox,
  projectImageNorm,
  unprojectImageNorm,
  type StackCamera,
} from "./sketchProjection.ts";
import { drawDurationMs, roughArrowHead, roughPaths, sketchSeed } from "./roughStroke.ts";
import type { Finding } from "./types.ts";

function finding(partial: Partial<Finding> & Pick<Finding, "id" | "label">): Finding {
  return {
    description: "A 2 cm spiculated nodule.",
    teachingPoints: ["Compare to prior."],
    state: " ",
    marker: { x_pct: 0.32, y_pct: 0.4, shape: "circle" },
    order: 1,
    sliceIndex: 12,
    windowWidth: 1500,
    windowCenter: -600,
    seriesInstanceUID: "1.2.lung",
    ...partial,
  };
}

const camera: StackCamera = {
  columns: 512,
  rows: 512,
  canvasWidth: 800,
  canvasHeight: 800,
  fitScale: 800 / 511,
  zoom: 1,
  panX: 0,
  panY: 0,
};

test("zoom and pan move the screen point and keep the image point", () => {
  const fitted = projectImageNorm(0.32, 0.4, camera);
  assert.ok(fitted);
  const zoomed = projectImageNorm(0.32, 0.4, { ...camera, zoom: 2, panX: 40, panY: -20 });
  assert.ok(zoomed);
  assert.notEqual(Math.round(zoomed.x), Math.round(fitted.x));
  const back = unprojectImageNorm(zoomed.x, zoomed.y, { ...camera, zoom: 2, panX: 40, panY: -20 });
  assert.ok(back);
  assert.ok(Math.abs(back.x_pct - 0.32) < 1e-6);
  assert.ok(Math.abs(back.y_pct - 0.4) < 1e-6);
});

test("image fractions land on the DICOM plane", () => {
  const world = imageFractionToWorld(0, 0, {
    origin: [0, 0, 0],
    rowCosines: [1, 0, 0],
    columnCosines: [0, 1, 0],
    rowSpacing: 1,
    columnSpacing: 1,
    columns: 11,
    rows: 11,
  });
  assert.deepEqual(world, [-0.5, -0.5, 0]);
});

test("a card stays inside a phone viewport", () => {
  const size = cardPixelSize(390);
  assert.ok(size.width <= 390 - 16);
  const box = placeCardBox({ x: 300, y: 40 }, { width: 390, height: 700 }, size);
  assert.ok(box.x >= 8);
  assert.ok(box.y >= 8);
  assert.ok(box.x + size.width <= 390 - 8);
  const edge = leaderStart({ x: box.x, y: box.y, width: size.width, height: size.height }, { x: 300, y: 40 });
  assert.ok(edge.x >= box.x - 1 && edge.x <= box.x + size.width + 1);
});

test("rough strokes are seeded, curved, and timed inside 0.4–0.8s", () => {
  const seed = sketchSeed("f-nodule");
  const first = roughPaths("circle", seed).join(" ");
  const second = roughPaths("circle", seed).join(" ");
  assert.equal(first, second);
  assert.match(first, /[MC]/);
  assert.notEqual(roughPaths("circle", seed + 1).join(" "), first);
  assert.ok(roughArrowHead(seed)[0]?.includes("M"));
  for (const kind of ["circle", "ellipse", "arrow", "underline", "leader", "card"] as const) {
    const ms = drawDurationMs(kind);
    assert.ok(ms >= 400 && ms <= 800, kind);
  }
});

test("draw tools reject an invented point and accept the authored marker", () => {
  const pack = materializeLiveTeachingPack({
    caseId: "c1",
    modality: "CT",
    findings: [
      finding({
        id: "f1",
        label: "Spiculated nodule",
        measurements: [
          {
            id: "m1",
            kind: "arrow",
            handles: [
              [0.2, 0.28],
              [0.32, 0.4],
            ],
          },
        ],
      }),
    ],
  });
  const invented = validateLiveToolCall(pack, "draw_circle", { findingId: "f1", x_pct: 0.8, y_pct: 0.1 });
  assert.equal(invented.ok, false);
  const circle = validateLiveToolCall(pack, "draw_circle", { findingId: "f1" });
  assert.equal(circle.ok, true);
  if (circle.ok) {
    assert.equal(circle.marks?.[0]?.anchor.x_pct, 0.32);
    assert.equal(circle.marks?.[0]?.certainty, "authored");
    assert.equal(circle.sliceIndex, 12);
  }
  const arrow = resolveSketchTool(pack, "draw_arrow", { findingId: "f1" });
  assert.equal(arrow.ok, true);
  if (arrow.ok && !("clearOverlay" in arrow)) {
    assert.equal(arrow.marks[0]?.to?.x_pct, 0.32);
    assert.equal(arrow.marks[0]?.from?.x_pct, 0.2);
  }
  const offSlice = replaySketches(pack, "f1")[0]!;
  assert.equal(markVisibleOnSlice(offSlice, 12), true);
  assert.equal(markVisibleOnSlice(offSlice, 40), false);
});

test("a learner tap is drawn as uncertain and a mismatched point is refused", () => {
  const pack = materializeLiveTeachingPack({
    caseId: "c1",
    modality: "CT",
    findings: [finding({ id: "f1", label: "Spiculated nodule" })],
  });
  const missing = validateLiveToolCall(pack, "draw_circle", { uncertain: true }, undefined, {
    studentTap: null,
  });
  assert.equal(missing.ok, false);
  const tap = { x_pct: 0.61, y_pct: 0.22, sliceIndex: 4 };
  const marked = validateLiveToolCall(pack, "draw_circle", { uncertain: true }, undefined, { studentTap: tap });
  assert.equal(marked.ok, true);
  if (marked.ok) {
    assert.equal(marked.marks?.[0]?.certainty, "uncertain");
    assert.equal(marked.marks?.[0]?.caption, "uncertain");
    assert.equal(marked.marks?.[0]?.anchor.x_pct, 0.61);
  }
  const mismatch = resolveSketchTool(pack, "draw_arrow", { uncertain: true, x_pct: 0.1, y_pct: 0.1 }, { studentTap: tap });
  assert.equal(mismatch.ok, false);
  const visible = uncertainTapMark(tap);
  assert.equal(visible.certainty, "uncertain");
});

test("cards are filled templates and HTML is stripped", () => {
  assert.equal(plainTeachingText("<script>alert(1)</script> nodule", 40), "alert(1) nodule");
  const pack = materializeLiveTeachingPack({
    caseId: "c1",
    modality: "CT",
    findings: [
      finding({
        id: "f1",
        label: "Spiculated nodule",
        teachingPoints: ["Malignancy until proven otherwise."],
      }),
    ],
  });
  const html = validateLiveToolCall(pack, "place_card", {
    findingId: "f1",
    template: "sign",
    name: "<b>Nodule</b>",
    meaning: "<img src=x> irregular margin",
  });
  assert.equal(html.ok, true);
  if (html.ok) {
    const card = html.marks?.[0]?.card;
    assert.equal(card?.template, "sign");
    assert.equal(card?.title, "Nodule");
    assert.match(card?.lines[0] ?? "", /irregular margin/);
    assert.doesNotMatch(JSON.stringify(card), /<|>/);
  }
  const bad = resolveSketchTool(pack, "place_card", { findingId: "f1", template: "html" });
  assert.equal(bad.ok, false);
  const fromPack = fillDiagramCard("differential", {}, pack.findings[0]);
  assert.equal(fromPack?.lines[0], "Malignancy until proven otherwise.");
});

test("jump_to_key_view returns the authored camera and clear_overlay draws nothing", () => {
  const pack = materializeLiveTeachingPack({
    caseId: "c1",
    modality: "CT",
    findings: [
      finding({
        id: "f1",
        label: "Spiculated nodule",
        track: {
          durationMs: 1000,
          start: { sliceIndex: 12, ww: 1500, wc: -600 },
          events: [{ t: 10, type: "camera", zoom: 2.2, pan: [12, -4] }],
        },
      }),
    ],
  });
  const jump = validateLiveToolCall(pack, "jump_to_key_view", { findingId: "f1", sliceIndex: 99, ww: 1 });
  assert.equal(jump.ok, true);
  if (jump.ok) {
    assert.equal(jump.sliceIndex, 12);
    assert.equal(jump.ww, 1500);
    assert.equal(jump.wc, -600);
    assert.equal(jump.zoom, 2.2);
    assert.deepEqual(jump.marks, []);
  }
  const cleared = validateLiveToolCall(pack, "clear_overlay", {});
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.equal(cleared.clearOverlay, true);
});

test("reaching a finding replays anchored marks", () => {
  const pack = materializeLiveTeachingPack({
    caseId: "c1",
    modality: "CT",
    findings: [finding({ id: "f1", label: "Spiculated nodule" })],
  });
  const marks = replaySketches(pack, "f1", 7);
  assert.deepEqual(
    marks.map((mark) => mark.kind),
    ["circle", "arrow", "card"]
  );
  assert.ok((marks[0]?.delayMs ?? 0) < (marks[1]?.delayMs ?? 0));
  assert.ok((marks[1]?.delayMs ?? 0) < (marks.find((mark) => mark.kind === "card")?.delayMs ?? 0));
  assert.ok(marks.every((mark) => mark.anchor.x_pct === 0.32 && mark.certainty === "authored"));
  assert.equal(marks.find((mark) => mark.kind === "card")?.card?.title, "Spiculated nodule");
  const frame = frameFromCamera(camera, 12);
  const projected = frame.project(0.32, 0.4);
  assert.ok(projected);
  assert.ok(projected.x > 0 && projected.x < camera.canvasWidth);
});
