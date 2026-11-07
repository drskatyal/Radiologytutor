import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anonymisedDicomPath,
  anonymousLines,
  buildMjpegAvi,
  exportBaseName,
  seriesFrameName,
  zipBytes,
} from "./viewerExport.ts";
import { buildMjpegAvi as desktopBuildMjpegAvi, exportBaseName as desktopBaseName } from "../desktop/src/viewer/exporter.ts";
import { readZipDirectory } from "../packages/viewer-core/src/zipArchive.ts";

const jpeg = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37) & 0xff);

test("the AVI container is byte-for-byte the desktop's", () => {
  const frames = [jpeg(101), jpeg(64), jpeg(3)];
  assert.deepEqual(buildMjpegAvi(frames, 512, 384, 15), desktopBuildMjpegAvi(frames, 512, 384, 15));
  const avi = buildMjpegAvi(frames, 512, 384, 15);
  const ascii = (o: number) => String.fromCharCode(...avi.subarray(o, o + 4));
  assert.equal(ascii(0), "RIFF");
  assert.equal(ascii(8), "AVI ");
  assert.equal(new DataView(avi.buffer).getUint32(4, true), avi.length - 8);
});

test("file names carry no patient details and match the desktop", () => {
  const at = new Date(2026, 10, 7, 9, 5, 3);
  assert.equal(exportBaseName({ modality: "CT", seriesNumber: 3 }, at), "CT_se3_20261107-090503");
  assert.equal(exportBaseName({ modality: "CT", seriesNumber: 3 }, at), desktopBaseName({ modality: "CT", seriesNumber: 3 }, at));
  assert.equal(exportBaseName({}, at), "image_20261107-090503");
  assert.equal(seriesFrameName("CT", 6, 120, "png"), "CT_0007.png");
  assert.equal(seriesFrameName("CT", 0, 12345, "jpg"), "CT_00001.jpg");
  assert.equal(anonymisedDicomPath(0, 41), "DICOM/SE001/IM00042.dcm");
});

test("the anonymous overlay line holds series, image and window only", () => {
  assert.deepEqual(anonymousLines({ modality: "CT", seriesNumber: 2, index: 9, count: 40, ww: 399.6, wc: 40.2 }), ["CT · Se 2", "Im 10 / 40 · W 400 L 40"]);
  assert.deepEqual(anonymousLines({ modality: null, seriesNumber: null, index: 0, count: 1 }), ["Im 1 / 1"]);
});

test("zipBytes writes a ZIP the viewer can read back", async () => {
  const blob = zipBytes([
    { name: "a.png", bytes: jpeg(10) },
    { name: "DICOM/SE001/IM00001.dcm", bytes: jpeg(300) },
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const entries = await readZipDirectory(async (o, n) => bytes.subarray(o, o + n), bytes.length);
  assert.deepEqual(entries.map((e) => e.name), ["a.png", "DICOM/SE001/IM00001.dcm"]);
});
