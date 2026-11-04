import { test } from "node:test";
import assert from "node:assert/strict";
import { readZipDirectory } from "../../packages/viewer-core/src/zipArchive.ts";
import { ZipWriter, crc32 } from "./zipWriter.ts";

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("the written archive is readable by the viewer's own ZIP reader", async () => {
  const zip = new ZipWriter();
  const parts: Uint8Array[] = [];
  parts.push(...zip.file("study/series-1/IM00001.dcm", new Uint8Array([1, 2, 3])));
  parts.push(...zip.file("study/series-1/IM00002.dcm", new Uint8Array(1000).fill(7)));
  parts.push(zip.finish());
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  const read = async (start: number, end: number) => all.subarray(start, end);
  const entries = await readZipDirectory(read, all.length);
  assert.deepEqual(entries.map((e) => e.name), ["study/series-1/IM00001.dcm", "study/series-1/IM00002.dcm"]);
});
