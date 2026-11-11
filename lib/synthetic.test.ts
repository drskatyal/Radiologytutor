import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { syntheticStudy, STUDY, SERIES_A, SERIES_B } from "../scripts/make-synthetic-study.mjs";
import { startMockDicomweb } from "../scripts/bench/mockDicomweb.mjs";

test("synthetic fixture is byte-identical across generations and matches committed SHA-256", async () => {
  const first = syntheticStudy(), second = syntheticStudy();
  const hashes = JSON.parse(first.get("sha256.json")!.toString());
  for (const [name, bytes] of first) {
    assert.deepEqual(bytes, second.get(name));
    assert.deepEqual(bytes, await readFile(`fixtures/synthetic/${name}`));
    if (name !== "sha256.json") assert.equal(createHash("sha256").update(bytes).digest("hex"), hashes[name]);
  }
  const manifest = JSON.parse(first.get("study.json")!.toString());
  assert.deepEqual(manifest.instances.slice(0, 3).map((i: { positions: number[][] }) => i.positions[0][2]), [6, 0, 3]);
  assert.equal(manifest.instances[3].metadata["00280030"], undefined);
  assert.equal(manifest.instances[4].frames, 4);
  assert.deepEqual(manifest.instances[4].metadata["00280030"].Value, [0.7, 0.9]);
});

test("synthetic archive preserves identity, order and distinct multiframe pixels", async () => {
  const archive = await startMockDicomweb({ synthetic: true, rows: 64, columns: 64, latencyMs: 0 });
  try {
    const base = `${archive.origin}/dicomweb/studies/${STUDY}/series`;
    const metadata = await (await fetch(`${base}/${SERIES_A}/metadata`)).json();
    assert.deepEqual(metadata.slice(0, 3).map((i: Record<string, { Value: unknown[] }>) => i["00200013"].Value[0]), [3, 1, 2]);
    const frame = (n: number) => fetch(`${base}/${SERIES_B}/instances/${SERIES_B}.1/frames/${n}`);
    const a = Buffer.from(await (await frame(2)).arrayBuffer()), b = Buffer.from(await (await frame(3)).arrayBuffer());
    assert.notDeepEqual(a, b);
    assert.equal((await frame(5)).status, 404);
  } finally { await archive.close(); }
});
