import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  bundleOpenIndex,
  chunkOrdinalFor,
  entryBytes,
  isBundleFile,
  isUsableIndex,
  packContainer,
  planFetchOrder,
  unpackContainer,
  type ChunkRef,
  type SeriesBundleIndex,
} from "./format";

function chunks(total: number, size: number, prefix: "p" | "f"): ChunkRef[] {
  const out: ChunkRef[] = [];
  for (let start = 0, n = 0; start < total; start += size, n++) {
    out.push({ file: `${prefix}${String(n).padStart(4, "0")}.frb`, start, count: Math.min(size, total - start), bytes: 1 });
  }
  return out;
}

function index(total: number): SeriesBundleIndex {
  return {
    schema: 1,
    version: "abcdef0123456789",
    studyInstanceUID: "1.2.3",
    seriesInstanceUID: "1.2.3.4",
    createdAt: "2026-10-31T00:00:00.000Z",
    sops: Array.from({ length: total }, (_, i) => `1.2.3.4.${i + 1}`),
    meta: { file: "meta.gz", bytes: 10 },
    previews: { format: "jpeg", maxDim: 384, chunks: chunks(total, 32, "p") },
    frames: { transferSyntaxUID: "1.2.840.10008.1.2.4.202", chunks: chunks(total, 8, "f") },
  };
}

test("container round-trips header and payload byte-for-byte", () => {
  const header = new Uint8Array([1, 2, 3, 4, 5]);
  const a = new Uint8Array([10, 11]);
  const b = new Uint8Array([20, 21, 22]);
  const packed = packContainer(header, [a, b]);
  const { gzHeader, payload } = unpackContainer(packed);
  assert.deepEqual([...gzHeader], [1, 2, 3, 4, 5]);
  assert.deepEqual([...payload], [10, 11, 20, 21, 22]);
  assert.deepEqual([...entryBytes(payload, { i: 1, sop: "x", off: 2, len: 3 })], [20, 21, 22]);
});

test("a corrupt or foreign body is refused, not misread", () => {
  assert.throws(() => unpackContainer(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0, 0, 0, 0])), /Not a frame bundle/);
  const packed = packContainer(new Uint8Array(4), []);
  new DataView(packed.buffer).setUint32(4, 999, true);
  assert.throws(() => unpackContainer(packed), /truncated/);
  assert.throws(() => entryBytes(new Uint8Array(4), { i: 0, sop: "x", off: 2, len: 5 }), /outside/);
});

test("chunk lookup finds the range holding a slice, -1 outside the stack", () => {
  const c = chunks(100, 8, "f");
  assert.equal(chunkOrdinalFor(c, 0), 0);
  assert.equal(chunkOrdinalFor(c, 7), 0);
  assert.equal(chunkOrdinalFor(c, 8), 1);
  assert.equal(chunkOrdinalFor(c, 99), 12);
  assert.equal(chunkOrdinalFor(c, 100), -1);
});

test("fetch plan: current preview, current full, then outward — previews pulled ahead", () => {
  const idx = index(1000);
  const plan = planFetchOrder(idx, 500, { preview: new Set(), full: new Set() });
  assert.deepEqual(plan[0], { kind: "preview", ordinal: 15, score: -2 }); // 480..511
  assert.equal(plan[1].kind, "full");
  assert.equal(plan[1].ordinal, 62); // 496..503
  // Immediate full neighbours come before far previews, but previews of the
  // whole 1000-slice stack arrive before the far full frames.
  const firstFarFull = plan.findIndex((p) => p.kind === "full" && Math.abs(p.ordinal - 62) > 40);
  const lastPreview = plan.map((p) => p.kind).lastIndexOf("preview");
  assert.ok(lastPreview < firstFarFull, "all previews before far full chunks");
  assert.equal(plan.length, idx.previews.chunks.length + idx.frames.chunks.length);
});

test("fetch plan skips what is already on the device", () => {
  const idx = index(64);
  const plan = planFetchOrder(idx, 0, { preview: new Set([0, 1]), full: new Set([0]) });
  assert.ok(plan.every((p) => p.kind === "full"));
  assert.equal(plan[0].ordinal, 1);
});

test("open index mirrors the DICOMweb path: SOP, then slice, then middle", () => {
  const sops = ["a", "b", "c", "d", "e"];
  assert.equal(bundleOpenIndex(sops, { sopInstanceUID: "d", sliceIndex: 0 }), 3);
  assert.equal(bundleOpenIndex(sops, { sopInstanceUID: "zz", sliceIndex: 1 }), 1);
  assert.equal(bundleOpenIndex(sops, { sliceIndex: 99 }), 4);
  assert.equal(bundleOpenIndex(sops, null), 2);
  assert.equal(bundleOpenIndex([], null), 0);
});

test("only well-formed indexes and file names are accepted", () => {
  assert.ok(isUsableIndex(index(10)));
  assert.ok(!isUsableIndex({ ...index(10), schema: 99 }));
  assert.ok(!isUsableIndex({ ...index(10), version: "../../etc" }));
  assert.ok(!isUsableIndex({ ...index(10), frames: { transferSyntaxUID: "x", chunks: [] } }));
  assert.ok(isBundleFile("p0001.frb") && isBundleFile("f0123.frb") && isBundleFile("meta.gz"));
  assert.ok(!isBundleFile("../index.json") && !isBundleFile("index.json") && !isBundleFile("p1.frb"));
});
