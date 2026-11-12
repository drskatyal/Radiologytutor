import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesView } from "./match";
import { RenderCoordinator, ViewRequestError } from "./renderAck";
import type { ViewerSnapshot } from "./types";
export const snapshot: ViewerSnapshot = {
  studyUID: "1", seriesUID: "1.1", sopUID: "1.1.1", frame: 2, viewportId: "primary", layout: "1x1",
  voi: { ww: 400, wc: 40 }, invert: false,
  camera: { zoom: 1, pan: [0, 0], rotation: 0, flipH: false, flipV: false },
  orientation: { normal: [0, 0, 1], up: [0, -1, 0] }, renderSeq: 1,
};
test("M4 matching requires exact identity/frame/layout and full display state within explicit tolerances", () => {
  assert.ok(matchesView(snapshot, structuredClone(snapshot)));
  const close = structuredClone(snapshot); close.camera.pan[0] += 0.4; close.camera.zoom += 0.004;
  assert.ok(matchesView(close, snapshot));
  for (const key of ["studyUID", "seriesUID", "sopUID", "viewportId", "layout"] as const) assert.equal(matchesView({ ...snapshot, [key]: "other" }, snapshot), false);
  assert.equal(matchesView({ ...snapshot, frame: 3 }, snapshot), false);
  assert.equal(matchesView({ ...snapshot, invert: true }, snapshot), false);
  for (const patch of [{ zoom: 2 }, { pan: [1, 0] as [number, number] }, { rotation: 90 }, { flipH: true }, { flipV: true }]) assert.equal(matchesView({ ...snapshot, camera: { ...snapshot.camera, ...patch } }, snapshot), false);
  assert.equal(matchesView({ ...snapshot, voi: { ww: 402, wc: 40 } }, snapshot), false);
  assert.equal(matchesView({ ...snapshot, orientation: { ...snapshot.orientation, up: [1, 0, 0] } }, snapshot), false);
});
test("P0-3/T10 drive/settle completion never acknowledges: wait for a new matching render", async () => {
  const broker = new RenderCoordinator(); broker.publish({ snapshot, at: 1 }); let resolved = false;
  const promise = broker.request({ commandId: "c", generation: 1, snapshot, timeoutMs: 200 }, async () => {}).then(ack => { resolved = true; return ack; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(resolved, false);
  broker.publish({ snapshot: { ...snapshot, frame: 3, renderSeq: 2 }, at: 12 });
  await Promise.resolve(); assert.equal(resolved, false);
  broker.publish({ snapshot: { ...snapshot, renderSeq: 3 }, at: 30 });
  assert.equal((await promise).at, 30); assert.equal(resolved, true);
});
test("T10 timeout fails closed and superseded commands cannot consume later acknowledgements", async () => {
  const broker = new RenderCoordinator();
  await assert.rejects(broker.request({ commandId: "missing", generation: 0, snapshot, timeoutMs: 5 }, async () => {}), (error: unknown) => error instanceof ViewRequestError && error.code === "timeout");
  const first = broker.request({ commandId: "old", generation: 1, snapshot }, async () => {});
  const rejected = assert.rejects(first, (error: unknown) => error instanceof ViewRequestError && error.code === "cancelled");
  const second = broker.request({ commandId: "new", generation: 2, snapshot }, async () => {});
  broker.publish({ snapshot: { ...snapshot, renderSeq: 2 }, at: 50 });
  assert.equal((await second).commandId, "new"); await rejected;
});
