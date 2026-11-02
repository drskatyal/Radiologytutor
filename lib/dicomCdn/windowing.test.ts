import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  describePixels,
  percentileWindow,
  previewSize,
  previewToStoredBytes,
  rawPixelView,
  renderPreview8,
  storedWindow,
} from "./windowing";

const CT_META = {
  "00280010": { Value: [4] },
  "00280011": { Value: [4] },
  "00280100": { Value: [16] },
  "00280103": { Value: [1] },
  "00280002": { Value: [1] },
  "00281052": { Value: ["-1024"] },
  "00281053": { Value: ["1"] },
  "00281050": { Value: ["40", "-600"] },
  "00281051": { Value: ["400", "1500"] },
  "00280004": { Value: ["MONOCHROME2"] },
};

test("pixel module and the FIRST stored window are read from DICOM JSON", () => {
  const d = describePixels(CT_META)!;
  assert.equal(d.rows, 4);
  assert.equal(d.rescaleIntercept, -1024);
  assert.equal(d.pixelRepresentation, 1);
  assert.deepEqual(storedWindow(CT_META), { center: 40, width: 400 });
  assert.equal(storedWindow({}), undefined);
  assert.equal(describePixels({}), null);
});

test("preview size caps the long edge and never upscales", () => {
  assert.deepEqual(previewSize(512, 512, 384), { w: 384, h: 384 });
  assert.deepEqual(previewSize(2048, 1024, 384), { w: 192, h: 384 });
  assert.deepEqual(previewSize(256, 256, 384), { w: 256, h: 256 });
});

test("preview → modality round trip stays within one grey step of the window", () => {
  // Stored values; HU = stored − 1024. Window 40/400 → [-160, 240].
  const stored = new Int16Array([864, 1024, 1064, 1264, 2000, 0, 900, 1100, 1000, 1050, 1150, 1200, 870, 990, 1010, 1240]);
  const p = renderPreview8(stored, 4, 4, 1, -1024, { center: 40, width: 400 }, 384);
  assert.equal(p.lo, -160);
  assert.equal(p.hi, 240);
  assert.equal(p.data[0], 0); // -160 HU
  assert.equal(p.data[3], 255); // 240 HU
  assert.equal(p.data[4], 255); // clipped above
  assert.equal(p.data[5], 0); // clipped below
  const bytes = previewToStoredBytes(p.data, p.w, p.h, describePixels(CT_META)!, p.lo, p.hi);
  assert.equal(bytes.byteLength, 4 * 4 * 2);
  const back = new Int16Array(bytes.buffer, bytes.byteOffset, 16);
  const step = 400 / 255;
  for (let i = 0; i < stored.length; i++) {
    const clipped = Math.max(864, Math.min(1264, stored[i])); // window in stored units
    assert.ok(Math.abs(back[i] - clipped) <= step, `pixel ${i}: ${back[i]} vs ${clipped}`);
  }
});

test("downscale averages blocks", () => {
  const px = new Uint16Array([0, 0, 100, 100, 0, 0, 100, 100, 200, 200, 50, 50, 200, 200, 50, 50]);
  const p = renderPreview8(px, 4, 4, 1, 0, { center: 127.5, width: 255 }, 2);
  assert.deepEqual([p.w, p.h], [2, 2]);
  assert.deepEqual([...p.data], [0, 100, 200, 50]);
});

test("raw views honour signedness and copy unaligned input", () => {
  const bytes = new Uint8Array([0xff, 0xff, 0x01, 0x00, 0, 0]);
  const signed = rawPixelView(bytes.subarray(0, 4), { bitsAllocated: 16, pixelRepresentation: 1, rows: 1, columns: 2 });
  assert.deepEqual([...signed], [-1, 1]);
  const unaligned = rawPixelView(bytes.subarray(1, 5), { bitsAllocated: 16, pixelRepresentation: 0, rows: 1, columns: 2 });
  assert.deepEqual([...unaligned], [0x01ff, 0x0000]);
});

test("percentile window ignores outliers", () => {
  const px = new Int16Array(10_000).map((_, i) => (i % 100) * 10);
  px[0] = -30000;
  px[1] = 30000;
  const w = percentileWindow(px, 1, 0);
  assert.ok(w.center > 400 && w.center < 600);
  assert.ok(w.width < 1100);
});

test("stored-byte previews clamp to the frame's integer range", () => {
  const desc = { rows: 1, columns: 2, bitsAllocated: 16, pixelRepresentation: 0, rescaleSlope: 1, rescaleIntercept: -1024 };
  // Window reaching below the unsigned floor (−1100 HU → stored −76) clamps to 0.
  const bytes = previewToStoredBytes(new Uint8Array([0, 255]), 2, 1, desc, -1100, 1000);
  const back = new Uint16Array(bytes.buffer, bytes.byteOffset, 2);
  assert.deepEqual([...back], [0, 2024]);
});
