import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOpenIndex, resolveImageOpenIndex, wadorsImageId } from "./viewerLoad";
import { bundleOpenIndex } from "./dicomCdn/format";
const id = (sop: string, frame = 1) => wadorsImageId("/api/dicomweb", "study", "series", sop, frame);
test("M4/T3 missing or ambiguous named SOP never silently keeps a stored index (archive or bundle)", () => {
  for (const sops of [[], ["a", "b"], ["missing", "missing"]]) {
    assert.throws(() => resolveOpenIndex(sops.length, sops, { sopInstanceUID: "missing", sliceIndex: 1 }));
    assert.throws(() => bundleOpenIndex(sops, { sopInstanceUID: "missing", sliceIndex: 1 }));
  }
});
test("M4 progressive first frame: archive offset and sorted stack index differ, identity is stable", () => {
  const archive = [id("c"), id("a"), id("b")];
  const sorted = [id("a"), id("b"), id("c")];
  assert.equal(resolveImageOpenIndex(sorted, { sliceIndex: 0 }, archive[0]), 2);
  assert.throws(() => resolveImageOpenIndex(sorted.slice(0, 2), { sliceIndex: 0 }, archive[0]));
  assert.equal(resolveImageOpenIndex(sorted, { sopInstanceUID: "c", sliceIndex: 0 }), 2);
});
test("M4 full-stack navigation distinguishes frames of the same SOP; missing frame fails closed", () => {
  const frames = [1, 2, 3, 4].map(frame => id("multi", frame));
  assert.equal(resolveImageOpenIndex(frames, { sopInstanceUID: "multi", frameNumber: 3 }), 2);
  assert.equal(resolveImageOpenIndex([...frames].reverse(), undefined, frames[2]), 1);
  assert.throws(() => resolveImageOpenIndex(frames, { sopInstanceUID: "multi", frameNumber: 5, sliceIndex: 0 }));
});
