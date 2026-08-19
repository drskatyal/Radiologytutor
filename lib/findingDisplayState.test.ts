import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authoredDisplayState,
  sopUidFromImageId,
  withDisplaySnapshot,
} from "./findingDisplayState.ts";

test("sopUidFromImageId parses wadors imageIds", () => {
  const id =
    "wadors:https://example/dicomweb/studies/1.2/series/3.4/instances/5.6.7/frames/1";
  assert.equal(sopUidFromImageId(id), "5.6.7");
  assert.equal(sopUidFromImageId(undefined), undefined);
});

test("withDisplaySnapshot copies VOI and SOP onto a finding draft", () => {
  const f = withDisplaySnapshot(
    { label: "Nodule", marker: { x_pct: 0.3, y_pct: 0.4, shape: "circle" } },
    { sliceIndex: 12, ww: 1500, wc: -600, sopInstanceUID: "1.2.3" }
  );
  assert.equal(f.sliceIndex, 12);
  assert.equal(f.windowWidth, 1500);
  assert.equal(f.windowCenter, -600);
  assert.equal(f.sopInstanceUID, "1.2.3");
});

test("authoredDisplayState prefers authored VOI over Pacsbin fallback", () => {
  const view = authoredDisplayState(
    { sliceIndex: 4, windowWidth: 1500, windowCenter: -600 },
    { sliceFraction: 0.5, windowWidth: 400, windowCenter: 40, zoom: 1.2 }
  );
  assert.equal(view.sliceIndex, 4);
  assert.equal(view.windowWidth, 1500);
  assert.equal(view.windowCenter, -600);
  assert.equal(view.zoom, 1.2);
  assert.equal(view.sliceFraction, undefined);
});

test("authoredDisplayState keeps fallback VOI when finding has none", () => {
  const view = authoredDisplayState(
    { sliceIndex: undefined },
    { sliceFraction: 0.25, windowWidth: 400, windowCenter: 40 },
    0.9
  );
  assert.equal(view.windowWidth, 400);
  assert.equal(view.sliceFraction, 0.25);
});
