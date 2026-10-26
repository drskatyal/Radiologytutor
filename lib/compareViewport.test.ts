import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHARED_RENDERING_ENGINE_ID,
  ViewportEngineRegistry,
  acquireViewportSlot,
  planViewportLayoutRestore,
  releaseViewportSlot,
  viewportIdFor,
} from "./compareViewport.ts";

const lung = { ww: 1500, wc: -600 };

test("primary and compare share one engine id and distinct viewport ids", () => {
  assert.equal(SHARED_RENDERING_ENGINE_ID, "flowrad-engine");
  assert.equal(viewportIdFor("primary"), "FLOWRAD_STACK_primary");
  assert.equal(viewportIdFor("compare"), "FLOWRAD_STACK_compare");
  assert.notEqual(viewportIdFor("primary"), viewportIdFor("compare"));
});

test("closing compare disables the second pane and leaves the engine up", () => {
  const opened = acquireViewportSlot(
    acquireViewportSlot([], "primary").holders,
    "compare"
  );
  assert.equal(opened.createEngine, false);
  assert.deepEqual(opened.holders, ["primary", "compare"]);

  const closed = releaseViewportSlot(opened.holders, "compare");
  assert.equal(closed.disableViewport, true);
  assert.equal(closed.destroyEngine, false);
  assert.deepEqual(closed.holders, ["primary"]);

  const last = releaseViewportSlot(closed.holders, "primary");
  assert.equal(last.destroyEngine, true);
  assert.deepEqual(last.holders, []);
});

test("releasing an unknown pane does not destroy the engine", () => {
  const plan = releaseViewportSlot(["primary"], "compare");
  assert.equal(plan.disableViewport, false);
  assert.equal(plan.destroyEngine, false);
  assert.deepEqual(plan.holders, ["primary"]);
});

test("registry close-compare sequence matches the pure slot plan", () => {
  const registry = new ViewportEngineRegistry();
  assert.equal(registry.acquire("primary").createEngine, true);
  assert.equal(registry.acquire("compare").createEngine, false);
  const closed = registry.release("compare");
  assert.equal(closed.destroyEngine, false);
  assert.equal(registry.size, 1);
  assert.equal(registry.release("primary").destroyEngine, true);
  assert.equal(registry.size, 0);
});

test("close compare keeps a teach camera and the live lung window", () => {
  const plan = planViewportLayoutRestore({
    width: 960,
    height: 720,
    live: { sliceIndex: 42, zoom: 2.2, pan: [18, -6], ...lung },
    lastGood: { sliceIndex: 42, zoom: 2.2, pan: [18, -6], ...lung },
  });
  assert.equal(plan.keepCamera, true);
  assert.equal(plan.reapply, null);
  assert.equal(plan.ww, 1500);
  assert.equal(plan.wc, -600);
  assert.equal(plan.sliceIndex, 42);
});

test("close compare fits a poisoned camera and keeps the live lung window", () => {
  const plan = planViewportLayoutRestore({
    width: 960,
    height: 720,
    live: { sliceIndex: 42, zoom: Number.NaN, pan: [Number.NaN, 0], ...lung },
    lastGood: { sliceIndex: 40, zoom: 2.2, pan: [18, -6], ww: 1600, wc: -500 },
  });
  assert.equal(plan.keepCamera, false);
  assert.deepEqual(plan.reapply, { zoom: 2.2, pan: [18, -6] });
  // The readout is still the teach window — do not fall back to the snapshot.
  assert.equal(plan.ww, 1500);
  assert.equal(plan.wc, -600);
  assert.equal(plan.sliceIndex, 42);
});

test("a 0×0 pane does not keep the camera measured against the empty layout", () => {
  const plan = planViewportLayoutRestore({
    width: 0,
    height: 0,
    live: { sliceIndex: 42, zoom: 2.2, pan: [0, 0], ...lung },
    lastGood: { sliceIndex: 42, zoom: 1.4, pan: [4, 2], ww: 1400, wc: -550 },
  });
  assert.equal(plan.keepCamera, false);
  assert.deepEqual(plan.reapply, { zoom: 1.4, pan: [4, 2] });
  assert.equal(plan.ww, 1500);
  assert.equal(plan.wc, -600);
});
