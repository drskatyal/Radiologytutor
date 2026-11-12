import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GENERIC_STRUCTURES } from "./anatomyCatalog.ts";

test("generic schematic glb names every catalog structure", () => {
  const buf = readFileSync(new URL("../public/anatomy/generic-schematic.glb", import.meta.url));
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString("utf8")) as {
    nodes: Array<{ name: string; translation: number[] }>;
    asset: { copyright?: string };
  };
  assert.match(json.asset.copyright ?? "", /CC0/);
  assert.match(json.asset.copyright ?? "", /Not a patient/);
  for (const item of GENERIC_STRUCTURES) {
    const node = json.nodes.find((entry) => entry.name === item.node);
    assert.ok(node, item.node);
    assert.ok(Math.abs((node?.translation[0] ?? 99) - item.position[0]) < 1e-6);
  }
});

test("a 3D finding mark shows only for the anchor it was built from", async () => {
  const { markMatchesFinding } = await import("./anatomyCatalog.ts");
  const mark = { label: "Left apical nodule", position: [0, 0, 0] as [number, number, number], sliceIndex: 6, marker: { x_pct: 0.68, y_pct: 0.494 } };
  assert.equal(markMatchesFinding(mark, { sliceIndex: 6, marker: { x_pct: 0.681, y_pct: 0.494 } }), true);
  // A store seeded before the fix still has the old anchor.
  assert.equal(markMatchesFinding(mark, { sliceIndex: 49, marker: { x_pct: 0.68, y_pct: 0.55 } }), false);
  assert.equal(markMatchesFinding(mark, undefined), false);
  // Older manifests without an anchor keep their mark.
  assert.equal(markMatchesFinding({ label: "x", position: [0, 0, 0] }, { sliceIndex: 1, marker: null }), true);
});
