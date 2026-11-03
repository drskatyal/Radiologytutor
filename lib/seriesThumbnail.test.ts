import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  THUMB_EDGE,
  ThumbnailCache,
  defaultThumbWindow,
  renderThumbRgba,
  sampleForThumb,
  thumbnailImageId,
} from "../packages/viewer-core/src/seriesThumbnail";

// Series thumbnails: the middle image, the series' default window, small.

test("the thumbnail image is the middle of the series", () => {
  assert.equal(thumbnailImageId([]), null);
  assert.equal(thumbnailImageId(["a"]), "a");
  assert.equal(thumbnailImageId(["a", "b"]), "a");
  assert.equal(thumbnailImageId(["a", "b", "c"]), "b");
  assert.equal(thumbnailImageId(Array.from({ length: 120 }, (_, i) => String(i))), "59");
});

test("sampling keeps the aspect, caps the edge and applies slope / intercept", () => {
  const cols = 1024;
  const rows = 512;
  const px = new Int16Array(cols * rows).map((_, i) => (i % cols < cols / 2 ? 0 : 1000));
  const s = sampleForThumb({ pixelData: px, columns: cols, rows, components: 1, slope: 1, intercept: -1024 }, 256)!;
  assert.equal(s.width, 256);
  assert.equal(s.height, 128);
  assert.equal(s.channels, 1);
  assert.equal(s.values[0], -1024); // left half: air
  assert.equal(s.values[255], -24); // right half: 1000 − 1024
  // Small images are not upscaled.
  const small = sampleForThumb({ pixelData: new Uint8Array(64 * 64), columns: 64, rows: 64, components: 1 }, 256)!;
  assert.equal(small.width, 64);
  // Truncated pixel data is refused rather than read out of bounds.
  assert.equal(sampleForThumb({ pixelData: new Uint8Array(10), columns: 64, rows: 64, components: 1 }), null);
});

test("colour images keep three channels and no rescale", () => {
  const rgb = new Uint8Array(4 * 4 * 3).fill(200);
  const s = sampleForThumb({ pixelData: rgb, columns: 4, rows: 4, components: 3, slope: 2, intercept: 5 })!;
  assert.equal(s.channels, 3);
  assert.deepEqual(Array.from(s.values.slice(0, 3)), [200, 200, 200]);
});

test("the default window is the file's, else the image's range", () => {
  const s = { width: 2, height: 1, channels: 1 as const, values: new Float32Array([-1000, 1000]) };
  assert.deepEqual(defaultThumbWindow(s, { windowCenter: [40, 60], windowWidth: "400" }), { ww: 400, wc: 40 });
  assert.deepEqual(defaultThumbWindow(s, null), { ww: 2000, wc: 0 });
  assert.deepEqual(defaultThumbWindow(s, { windowCenter: 40, windowWidth: 0 }), { ww: 2000, wc: 0 });
});

test("rendering windows, inverts and shrinks to the thumbnail edge", () => {
  const values = new Float32Array(256 * 256).map((_, i) => (i % 256 < 128 ? -1000 : 1000));
  const sample = { width: 256, height: 256, channels: 1 as const, values };
  const out = renderThumbRgba(sample, { ww: 400, wc: 40 });
  assert.equal(out.width, THUMB_EDGE);
  assert.equal(out.height, THUMB_EDGE);
  assert.equal(out.rgba[0], 0); // air below the window: black
  assert.equal(out.rgba[(THUMB_EDGE - 1) * 4], 255); // bone above it: white
  assert.equal(out.rgba[3], 255); // opaque
  const inv = renderThumbRgba(sample, { ww: 400, wc: 40 }, true);
  assert.equal(inv.rgba[0], 255);
});

test("the cache holds JPEG bytes under its cap and revokes what it drops", () => {
  const revoked: string[] = [];
  const cache = new ThumbnailCache(10, (u) => revoked.push(u));
  cache.set("a", "blob:a", 4);
  cache.set("b", "blob:b", 4);
  assert.equal(cache.get("a"), "blob:a"); // a is now most recent
  cache.set("c", "blob:c", 4); // over 10: the least recent (b) goes
  assert.deepEqual(revoked, ["blob:b"]);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.bytes(), 8);
  cache.clear();
  assert.deepEqual(revoked.sort(), ["blob:a", "blob:b", "blob:c"]);
  assert.equal(cache.bytes(), 0);
});

test("a rescaled CT with no file window is windowed over its MODALITY range (not the engine's stored-value default)", () => {
  // pydicom CT_small: stored 0…2200-ish, intercept −1024, no Window Center / Width.
  const stored = new Int16Array(64 * 64).map((_, i) => (i % 64 < 32 ? 100 : 2100));
  const s = sampleForThumb({ pixelData: stored, columns: 64, rows: 64, components: 1, slope: 1, intercept: -1024 })!;
  const win = defaultThumbWindow(s, null);
  assert.deepEqual(win, { ww: 2000, wc: 76 }); // −924 … 1076 HU
  const out = renderThumbRgba(s, win);
  assert.equal(out.rgba[0], 0);
  assert.equal(out.rgba[(out.width - 1) * 4], 255, "the bright half is white, not black");
  // The engine's fallback (centre of the STORED range) applied to HU would be ~1024 too high: mostly black.
  const wrong = renderThumbRgba(s, { ww: 2000, wc: 1100 });
  assert.ok(wrong.rgba[(out.width - 1) * 4] < 140, "documents the bug this guards against");
});
