import { test } from "node:test";
import assert from "node:assert/strict";
import { materializeLiveTeachingPack, validateLiveToolCall } from "./liveTeachingPack.ts";
import {
  fillDiagramCard,
  keepWith,
  markVisibleOnSlice,
  plainTeachingText,
  replaySketches,
  resolveSketchTool,
  uncertainTapMark,
} from "./sketchMarks.ts";
import {
  frameFromCamera,
  imageFractionToWorld,
  projectImageNorm,
  unprojectImageNorm,
  type StackCamera,
} from "./sketchProjection.ts";
import {
  arrowStrokes,
  brushOutline,
  dashStroke,
  drawDurationMs,
  inkSeed,
  loopOffsets,
  outlinePath,
  partialStroke,
  penProgress,
  polylineLength,
  squiggleStroke,
} from "./inkStroke.ts";
import { backgroundMask, cardEdgeToward, cardNeedsReseat, cardWidthFor, lumaGrid, placeCard } from "./cardPlacement.ts";
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

test("a card stays inside a phone viewport and clear of the ring", () => {
  const width = cardWidthFor(390);
  assert.ok(width <= 390 - 32);
  const anchor = { x: 300, y: 40 };
  const box = placeCard({ anchor, ringRadius: 24, card: { width, height: 110 }, viewport: { width: 390, height: 700 } });
  assert.ok(box.x >= 12 && box.y >= 12);
  assert.ok(box.x + width <= 390 - 12);
  assert.equal(cardNeedsReseat(box, anchor, 24, { width: 390, height: 700 }), false);
  const edge = cardEdgeToward(box, anchor);
  assert.ok(edge.x >= box.x - 1 && edge.x <= box.x + width + 1);
});

/** A synthetic slice: black outside, a bright body disc, a dark lung inside it. */
function syntheticSlice(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4;
      const body = Math.hypot((x - width / 2) / (width * 0.3), (y - height / 2) / (height * 0.38)) < 1;
      const lung = Math.hypot((x - width * 0.6) / (width * 0.08), (y - height / 2) / (height * 0.16)) < 1;
      const v = body ? (lung ? 14 : 210) : 0;
      data[k] = data[k + 1] = data[k + 2] = v;
      data[k + 3] = 255;
    }
  }
  return { width, height, data };
}

test("cards sit in the black outside the body, not on the lung", () => {
  const view = { width: 960, height: 600 };
  const grid = lumaGrid(syntheticSlice(view.width, view.height), view);
  const mask = backgroundMask(grid);
  // The lung is dark but enclosed by the body, so it is not background.
  const lungCell = Math.floor(300 / grid.cell) * grid.cols + Math.floor(576 / grid.cell);
  assert.equal(mask[lungCell], 0);
  assert.equal(mask[0], 1);
  const anchor = { x: 576, y: 300 };
  const place = placeCard({ anchor, ringRadius: 26, card: { width: 256, height: 120 }, viewport: view, grid });
  assert.ok(place.background > 0.9, `background ${place.background}`);
  // Outside the body ellipse entirely.
  const corners = [
    [place.x, place.y],
    [place.x + 256, place.y],
    [place.x, place.y + 120],
    [place.x + 256, place.y + 120],
  ];
  const insideBody = corners.filter(([x, y]) => Math.hypot((x! - 480) / 288, (y! - 300) / 228) < 1).length;
  assert.equal(insideBody, 0);
});

test("ink strokes are seeded, hand-shaped, and timed inside 0.4–0.8s", () => {
  const seed = inkSeed("f-nodule");
  const loop = loopOffsets(seed);
  assert.deepEqual(loopOffsets(seed), loop);
  assert.notDeepEqual(loopOffsets(seed + 1), loop);
  // The loop overshoots its start: the ends cross instead of meeting.
  const start = Math.atan2(loop[0]!.y, loop[0]!.x);
  const turns = loop.reduce((sum, p, i) => {
    if (i === 0) return 0;
    const a = Math.atan2(loop[i - 1]!.y, loop[i - 1]!.x);
    let d = Math.atan2(p.y, p.x) - a;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return sum + d;
  }, 0);
  assert.ok(Number.isFinite(start));
  assert.ok(Math.abs(turns) > Math.PI * 2 + 0.3, `swept ${turns}`);
  // Not a perfect circle.
  const radii = loop.map((p) => Math.hypot(p.x, p.y));
  assert.ok(Math.max(...radii) - Math.min(...radii) > 0.05);

  const strokes = arrowStrokes({ x: 0, y: 0 }, { x: 120, y: 40 }, seed);
  assert.equal(strokes.length, 3);
  assert.deepEqual(strokes[0]!.at(-1), { x: 120, y: 40 });
  const outline = brushOutline(strokes[0]!, { size: 5 });
  assert.ok(outline.length > 8);
  assert.match(outlinePath(outline), /^M.*Z$/);

  const leader = squiggleStroke({ x: 0, y: 0 }, { x: 200, y: 0 }, seed);
  assert.ok(leader.some((p) => Math.abs(p.y) > 1), "the leader wavers");
  const half = partialStroke(leader, 0.5);
  assert.ok(Math.abs(polylineLength(half) - polylineLength(leader) / 2) < 1);
  assert.ok(dashStroke(leader, 12, 8).length > 4);
  assert.equal(penProgress(0, 600), 0);
  assert.equal(penProgress(600, 600), 1);

  for (const kind of ["circle", "ellipse", "arrow", "underline", "leader", "card"] as const) {
    const ms = drawDurationMs(kind);
    assert.ok(ms >= 400 && ms <= 800, kind);
  }
});

test("one confident mark at a time", () => {
  const pack = materializeLiveTeachingPack({
    caseId: "c1",
    modality: "CT",
    findings: [finding({ id: "f1", label: "Spiculated nodule" }), finding({ id: "f2", label: "Effusion", order: 2 })],
  });
  const ring = replaySketches(pack, "f1", 1, "ring");
  const withCard = keepWith(ring, replaySketches(pack, "f1", 2, "card"));
  assert.deepEqual(withCard.map((mark) => mark.kind), ["circle", "card"]);
  const arrow = resolveSketchTool(pack, "draw_arrow", { findingId: "f1" });
  assert.ok(arrow.ok && "marks" in arrow);
  if (arrow.ok && "marks" in arrow) {
    // The arrow replaces the ring; the card stays with its finding.
    assert.deepEqual(keepWith(withCard, arrow.marks).map((mark) => mark.kind), ["card", "arrow"]);
  }
  // Another finding's ink clears this one's.
  const other = keepWith(withCard, replaySketches(pack, "f2", 3, "ring"));
  assert.deepEqual(other.map((mark) => mark.findingId), ["f2"]);
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
  // A ring, then the card once the hand lifts. No unrequested arrow.
  assert.deepEqual(
    marks.map((mark) => mark.kind),
    ["circle", "card"]
  );
  assert.ok((marks[0]?.delayMs ?? 0) + (marks[0]?.durationMs ?? 0) <= (marks[1]?.delayMs ?? 0));
  assert.equal(marks[1]?.rx, marks[0]?.rx);
  assert.ok(marks.every((mark) => mark.anchor.x_pct === 0.32 && mark.certainty === "authored"));
  assert.equal(marks.find((mark) => mark.kind === "card")?.card?.title, "Spiculated nodule");
  const frame = frameFromCamera(camera, 12);
  const projected = frame.project(0.32, 0.4);
  assert.ok(projected);
  assert.ok(projected.x > 0 && projected.x < camera.canvasWidth);
});
