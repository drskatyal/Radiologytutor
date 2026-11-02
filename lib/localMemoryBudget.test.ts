import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  IN_FLIGHT_HEADROOM,
  MIN_LOCAL_DECODED_CACHE_BYTES,
  decodedBytesPerFrame,
  localDecodedCacheBudget,
  rawToDecodedRatio,
} from "../packages/viewer-core/src/localMemoryBudget";
import type { LocalInstanceHeader } from "../packages/viewer-core/src/localStudy";

// The decoded-image cap for local studies must leave room for the raw Part 10
// file Cornerstone's loader keeps beside every cached image.

const MB = 1024 * 1024;
const ct = (i: number): LocalInstanceHeader => ({
  fileName: `IM${i}`,
  sizeBytes: 512 * 512 * 2 + 1200, // uncompressed slice + header
  rows: 512,
  columns: 512,
  bitsAllocated: 16,
  samplesPerPixel: 1,
});

test("decoded size per frame follows rows × columns × samples × bytes", () => {
  assert.equal(decodedBytesPerFrame(ct(1)), 512 * 512 * 2);
  assert.equal(decodedBytesPerFrame({ ...ct(1), bitsAllocated: 8, samplesPerPixel: 3 }), 512 * 512 * 3);
  assert.equal(decodedBytesPerFrame({ ...ct(1), rows: undefined }), null);
  // BitsAllocated missing: assume 16-bit, the common worst case for grayscale.
  assert.equal(decodedBytesPerFrame({ ...ct(1), bitsAllocated: undefined }), 512 * 512 * 2);
});

const usable = (budget: number) => budget * (1 - IN_FLIGHT_HEADROOM);

test("uncompressed CT: raw ≈ decoded, so the decoded cap is half the usable budget", () => {
  const headers = Array.from({ length: 520 }, (_, i) => ct(i));
  const ratio = rawToDecodedRatio(headers);
  assert.ok(ratio > 1 && ratio < 1.01, `ratio ${ratio}`);
  const cap = localDecodedCacheBudget(headers, 256 * MB);
  const expected = usable(256 * MB) / (1 + ratio);
  assert.ok(Math.abs(cap - expected) < 1024, `cap ${cap / MB} MB`);
  // decoded + raw at the cap leaves the in-flight headroom free.
  assert.ok(cap * (1 + ratio) <= usable(256 * MB) + 1);
});

test("JPEG 2000 MR: raw is a fraction of decoded, so most of the budget stays decoded", () => {
  const mr = (i: number): LocalInstanceHeader => ({
    fileName: `MR${i}`,
    sizeBytes: Math.round(256 * 256 * 2 * 0.4),
    rows: 256,
    columns: 256,
    bitsAllocated: 16,
  });
  const headers = Array.from({ length: 216 }, (_, i) => mr(i));
  const cap = localDecodedCacheBudget(headers, 1024 * MB);
  assert.ok(Math.abs(cap - Math.floor(usable(1024 * MB) / 1.4)) < MB, `cap ${cap / MB} MB`);
});

test("multiframe files count every frame; missing geometry assumes the worst case", () => {
  const cine: LocalInstanceHeader = { ...ct(0), numberOfFrames: 30, sizeBytes: 30 * 512 * 512 * 2 };
  assert.ok(Math.abs(rawToDecodedRatio([cine]) - 1) < 1e-9);
  assert.equal(rawToDecodedRatio([{ fileName: "x", sizeBytes: 1000 }]), 1);
});

test("the cap never drops below a screenful, nor above the device budget", () => {
  const huge = { ...ct(0), sizeBytes: 50 * 512 * 512 * 2 }; // absurd ratio → clamped to 4
  assert.equal(localDecodedCacheBudget([huge], 1024 * MB), Math.floor(usable(1024 * MB) / 5));
  assert.equal(localDecodedCacheBudget([ct(0)], 64 * MB), MIN_LOCAL_DECODED_CACHE_BYTES);
  assert.equal(localDecodedCacheBudget([ct(0)], 16 * MB), 16 * MB);
});
