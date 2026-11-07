// Web reconstruction source over a fake image loader (synthetic slices only).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWebReconSource, slicesFrom, type WebImageAccess } from "./recon/webReconSource";
import { sampleGridSync } from "../packages/viewer-core/src/recon";

function fakeAccess(n: number, rows = 8, columns = 10): WebImageAccess {
  return {
    plane: (id) => {
      const k = Number(id.split(":")[1]);
      return { imagePositionPatient: [0, 0, k * 3], rowCosines: [1, 0, 0], columnCosines: [0, 1, 0], rowPixelSpacing: 0.5, columnPixelSpacing: 0.75, rows, columns };
    },
    load: async (id) => {
      const k = Number(id.split(":")[1]);
      // Stored value = k (rescale: ×2 − 1000).
      return { pixels: new Uint16Array(rows * columns).fill(k), slope: 2, intercept: -1000 };
    },
    window: () => [400, 40],
  };
}

test("builds an oblique-ready volume from loader slices, rescale applied, any input order", async () => {
  const ids = Array.from({ length: 6 }, (_, k) => `synthetic:${k}`).reverse();
  const src = await buildWebReconSource(ids, fakeAccess(6));
  assert.deepEqual(src.geometry.dims, [10, 8, 6]);
  assert.deepEqual(src.geometry.spacing, [0.75, 0.5, 3]);
  assert.deepEqual(src.defaultWindow, [400, 40]);
  // Value at z = 6 mm (slice 2) = 2·2 − 1000.
  const img = sampleGridSync(src.volume, { kind: "plane", origin: [1, 1, 6], du: [1, 0, 0], dv: [0, 1, 0], width: 1, height: 1 });
  assert.equal(img.values[0], -996);
  const out = await src.sample({ kind: "plane", origin: [1, 1, 7.5], du: [1, 0, 0], dv: [0, 1, 0], width: 1, height: 1 }, "p0", new AbortController().signal);
  assert.equal(out.values[0], -995, "halfway between slices 2 and 3");
});

test("images without position or orientation are refused with a reader-facing message", () => {
  const access = { ...fakeAccess(2), plane: () => ({ rows: 8, columns: 10 }) };
  assert.throws(() => slicesFrom(["synthetic:0"], access), /no patient position/);
});

test("over budget: reduced resolution and a note", async () => {
  const ids = Array.from({ length: 12 }, (_, k) => `synthetic:${k}`);
  const src = await buildWebReconSource(ids, fakeAccess(12, 64, 64), { budgetBytes: 40_000 });
  assert.ok(src.note && /Reduced resolution/.test(src.note));
  assert.notDeepEqual(src.volume.reduced, [1, 1]);
});
