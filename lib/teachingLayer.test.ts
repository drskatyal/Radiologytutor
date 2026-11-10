import { test } from "node:test";
import assert from "node:assert/strict";
import { FREE_VIEWER_FEATURES, TEACHING_FEATURES } from "./viewerFeatures";
import {
  frameFeatures,
  isPaneClick,
  teachingViewer,
  tourMove,
  tourOrder,
  tourPosition,
  type TeachingControls,
} from "./teachingLayer";

function fakeControls(over: Partial<TeachingControls> = {}) {
  const calls: string[] = [];
  let active = "s1";
  const controls: TeachingControls = {
    ready: true,
    imageCount: 60,
    showState: async (state, ms) => void calls.push(`showState ${JSON.stringify(state)} ${ms ?? "-"}`),
    setWindow: async (ww, wc) => void calls.push(`setWindow ${ww} ${wc}`),
    setInvert: (on) => void calls.push(`invert ${on}`),
    reset: () => void calls.push("reset"),
    getStartState: () => ({ sliceIndex: 30, ww: 400, wc: 40, zoom: 1 }),
    seriesUIDs: ["s1", "s2"],
    get activeSeriesUID() {
      return active;
    },
    showSeries: (uid) => {
      calls.push(`showSeries ${uid}`);
      active = uid;
    },
    clearAnnotations: () => void calls.push("clear"),
    settle: async () => void calls.push("settle"),
    ...over,
  };
  return { controls, calls };
}

test("teachingViewer drives the live controls and reports the view", async () => {
  const { controls, calls } = fakeControls();
  const v = teachingViewer(() => controls);
  assert.equal(v.ready, true);
  assert.deepEqual(v.view(), { sliceIndex: 30, imageCount: 60, windowWidth: 400, windowCenter: 40, zoom: 1, seriesInstanceUID: "s1" });
  assert.equal(await v.showView({ sliceIndex: 12, windowWidth: 1500, windowCenter: -600 }, 300), true);
  assert.equal(await v.setWindow(1500, -600), true);
  assert.equal(v.setInvert(true), true);
  assert.equal(v.reset(), true);
  assert.equal(v.clearAnnotations(), true);
  assert.deepEqual(calls, [
    'showState {"sliceIndex":12,"windowWidth":1500,"windowCenter":-600} 300',
    "setWindow 1500 -600",
    "invert true",
    "reset",
    "clear",
  ]);
});

test("a series switch waits for the viewer to settle; the shown series and unknown UIDs do nothing", async () => {
  const { controls, calls } = fakeControls();
  const v = teachingViewer(() => controls);
  assert.equal(await v.showSeries("s1"), true, "already shown");
  assert.deepEqual(calls, []);
  assert.equal(await v.showSeries("s2"), true);
  assert.deepEqual(calls, ["showSeries s2", "settle"]);
  assert.equal(await v.showSeries("not-in-this-case"), false);
  assert.equal(calls.length, 2);
});

test("a cold or missing viewer is a no-op, never a throw", async () => {
  for (const get of [() => null, () => undefined, () => fakeControls({ ready: false }).controls]) {
    const v = teachingViewer(get);
    assert.equal(v.ready, false);
    assert.equal(v.view(), null);
    assert.equal(await v.showView({ sliceIndex: 1 }), false);
    assert.equal(await v.setWindow(400, 40), false);
    assert.equal(await v.showSeries("s2"), false);
    assert.equal(v.setInvert(true), false);
    assert.equal(v.reset(), false);
    assert.equal(v.clearAnnotations(), false);
    const off = v.onFrame(() => {});
    off();
  }
});

test("bad windows are refused before they reach the viewer", async () => {
  const { controls, calls } = fakeControls();
  const v = teachingViewer(() => controls);
  assert.equal(await v.setWindow(Number.NaN, 40), false);
  assert.equal(await v.setWindow(0, 40), false);
  assert.equal(await v.setWindow(400, Number.POSITIVE_INFINITY), false);
  assert.deepEqual(calls, []);
});

test("the wrapper follows a remounted viewer (the getter is read on every call)", async () => {
  const first = fakeControls();
  const second = fakeControls({ imageCount: 120 });
  let current = first.controls;
  const v = teachingViewer(() => current);
  assert.equal(v.view()?.imageCount, 60);
  current = second.controls;
  assert.equal(v.view()?.imageCount, 120);
  await v.setWindow(80, 40);
  assert.deepEqual(first.calls, []);
  assert.deepEqual(second.calls, ["setWindow 80 40"]);
});

test("onFrame subscribes through the viewer's view stream", () => {
  let listener: ((f: null) => void) | null = null;
  const { controls } = fakeControls({
    subscribeView: (l) => {
      listener = l as (f: null) => void;
      return () => {
        listener = null;
      };
    },
  });
  const seen: unknown[] = [];
  const off = teachingViewer(() => controls).onFrame((f) => seen.push(f));
  listener!(null);
  assert.deepEqual(seen, [null]);
  off();
  assert.equal(listener, null);
});

const steps = [
  { id: "c", order: 3 },
  { id: "a", order: 1 },
  { id: "b", order: 2 },
  { id: "b2", order: 2 },
];

test("tour order is by `order`, ties kept as authored", () => {
  assert.deepEqual(tourOrder(steps).map((s) => s.id), ["a", "b", "b2", "c"]);
  assert.deepEqual(tourOrder([]), []);
});

test("tour position reads 'Finding n of N' with ends", () => {
  assert.deepEqual(
    { ...tourPosition(steps, "b2")!, step: tourPosition(steps, "b2")!.step.id },
    { index: 2, total: 4, step: "b2", label: "Finding 3 of 4", hasPrev: true, hasNext: true }
  );
  assert.equal(tourPosition(steps, "a")!.hasPrev, false);
  assert.equal(tourPosition(steps, "c")!.hasNext, false);
  assert.equal(tourPosition(steps, "zzz"), null);
  assert.equal(tourPosition(steps, null), null);
});

test("tour moves clamp at the ends, and a move with no current step starts the tour", () => {
  assert.equal(tourMove(steps, "a", 1)!.id, "b");
  assert.equal(tourMove(steps, "c", 1)!.id, "c");
  assert.equal(tourMove(steps, "a", -1)!.id, "a");
  assert.equal(tourMove(steps, "b", 2)!.id, "c");
  assert.equal(tourMove(steps, null, 1)!.id, "a");
  assert.equal(tourMove(steps, "gone", -1)!.id, "a");
  assert.equal(tourMove([], "a", 1), null);
});

test("frame features: free viewer without a layer, the teaching set by default with one", () => {
  assert.deepEqual(frameFeatures(null, FREE_VIEWER_FEATURES), FREE_VIEWER_FEATURES);
  assert.deepEqual(frameFeatures({}, FREE_VIEWER_FEATURES), TEACHING_FEATURES);
  assert.deepEqual(frameFeatures({ features: { slabs: true } }, FREE_VIEWER_FEATURES), { ...TEACHING_FEATURES, slabs: true });
});

test("a pane click is a pointer that barely moved; a drag (scroll, pan, window) is not", () => {
  assert.equal(isPaneClick({ x: 10, y: 10 }, { x: 10, y: 10 }), true);
  assert.equal(isPaneClick({ x: 10, y: 10 }, { x: 15, y: 16 }), true, "within 8 px");
  assert.equal(isPaneClick({ x: 10, y: 10 }, { x: 19, y: 10 }), false);
  assert.equal(isPaneClick(null, { x: 10, y: 10 }), false, "no down (the press began elsewhere)");
});
