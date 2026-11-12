import test from "node:test";
import assert from "node:assert/strict";
import { displayedSnapshot, imagePointEvidence } from "./viewer";

test("render snapshot reads the displayed SOP/frame and every camera field", () => {
  const vp = {
    getCurrentImageId: () => "wadors:/api/dicomweb/studies/1.2/series/1.2.3/instances/1.2.3.4/frames/3",
    getProperties: () => ({ voiRange: { lower: -160, upper: 239 }, invert: true }),
    getZoom: () => 2, getPan: (): [number, number] => [10, -2],
    getCamera: () => ({ viewPlaneNormal: [0, 0, 1], viewUp: [0, -1, 0], flipHorizontal: true }),
    getViewPresentation: () => ({ rotation: 90 }),
  };
  const view = displayedSnapshot(vp, "pane", "single", 7)!;
  assert.equal(view.sopUID, "1.2.3.4"); assert.equal(view.frame, 3);
  assert.deepEqual(view.voi, { ww: 400, wc: 40 });
  assert.deepEqual(view.camera, { zoom: 2, pan: [10, -2], rotation: 90, flipH: true, flipV: false });
  assert.equal(view.renderSeq, 7);
  const point = imagePointEvidence(view, { x: .5, y: .25 }, [101, 201])!;
  assert.deepEqual(point.imagePoint, { x: 50, y: 50 });
  assert.deepEqual(point.snapshot, view);
  assert.notEqual(point.snapshot, view);
  assert.equal(imagePointEvidence(view, { x: 1.1, y: 0 }, [101, 201]), null);
  assert.equal(displayedSnapshot({ ...vp, getCurrentImageId: () => "index:3" }, "pane", "single", 8), null);
});


test("M7 recorded pan crosses Cornerstone's one-pixel deadband without widening render tolerance", async () => {
  const { applyRecordedPan } = await import("./viewer");
  let current: [number, number] = [9.28, -6.96]; const writes: number[][] = [];
  const vp = { getPan: () => current, setPan: (next: [number, number]) => { writes.push(next); if (next.every((value, index) => Math.abs(value - current[index]) < 1)) return; current = next; } };
  applyRecordedPan(vp, [10, -6]); assert.deepEqual(current, [10, -6]); assert.equal(writes.length, 3);
  writes.length = 0; applyRecordedPan(vp, [20, -16]); assert.deepEqual(current, [20, -16]); assert.equal(writes.length, 1);
});
