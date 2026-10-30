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
