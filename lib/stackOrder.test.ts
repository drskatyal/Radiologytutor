import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { orderStackDatasets, stackGeometry, stackOrder } from "./stackOrder";

// The LIDC chest CT exactly as the staging archive returned it (geometry only).
const lidc = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "lidcStackGeometry.json"), "utf8")) as {
  orientation: number[];
  archiveOrder: { instanceNumber: number; position: number[]; sliceLocation: number }[];
};
const dataset = (row: { instanceNumber?: number; position?: number[] }, orientation = lidc.orientation) => ({
  "00200037": { vr: "DS", Value: orientation },
  ...(row.position ? { "00200032": { vr: "DS", Value: row.position } } : {}),
  ...(row.instanceNumber != null ? { "00200013": { vr: "IS", Value: [row.instanceNumber] } } : {}),
});

test("LIDC staging stack: the archive order is not anatomy (the reviewer's Loc 344, 154, 119 …)", () => {
  assert.deepEqual(
    lidc.archiveOrder.slice(0, 5).map((r) => Math.round(r.sliceLocation)),
    [344, 154, 119, 334, 199]
  );
});

test("LIDC staging stack sorts head to foot, the way InstanceNumber runs (z −79 … −399)", () => {
  const ordered = orderStackDatasets(lidc.archiveOrder.map((r) => dataset(r)));
  const zs = ordered.map((d) => (d["00200032"] as { Value: number[] }).Value[2]);
  assert.equal(zs.length, 65);
  assert.equal(zs[0], -79);
  assert.equal(zs[64], -399);
  for (let i = 1; i < zs.length; i++) assert.ok(zs[i]! < zs[i - 1]!, `strictly cranial-first at ${i}`);
  const numbers = ordered.map((d) => (d["00200013"] as { Value: number[] }).Value[0]);
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), "matches InstanceNumber order");
  // The catalog's finding 2 (left upper lobe apex nodule, "index 6, cranial first")
  // is Loc 109 — upper chest — not the archive order's Loc 374 (kidney level).
  const loc = (i: number) => -(ordered[i]!["00200032"] as { Value: number[] }).Value[2];
  assert.equal(loc(6), 109);
  assert.equal(Math.round(lidc.archiveOrder[6]!.sliceLocation), 374);
});

test("position wins over InstanceNumber; direction follows InstanceNumber's run", () => {
  const axial = [1, 0, 0, 0, 1, 0];
  // Instance numbers rise with z: ascending.
  assert.deepEqual(
    stackOrder([30, 10, 20].map((z, i) => stackGeometry(dataset({ position: [0, 0, z], instanceNumber: [3, 1, 2][i] }, axial)))),
    [1, 2, 0]
  );
  // Instance numbers fall with z (the LIDC case): descending.
  assert.deepEqual(
    stackOrder([30, 10, 20].map((z, i) => stackGeometry(dataset({ position: [0, 0, z], instanceNumber: [1, 3, 2][i] }, axial)))),
    [0, 2, 1]
  );
  // No InstanceNumbers: most along the normal first (axial: cranial first).
  assert.deepEqual(stackOrder([10, 30, 20].map((z) => stackGeometry(dataset({ position: [0, 0, z] }, axial)))), [1, 2, 0]);
});

test("no or degenerate positions fall back to InstanceNumber, then the archive's order", () => {
  const axial = [1, 0, 0, 0, 1, 0];
  assert.deepEqual(stackOrder([3, 1, 2].map((n) => stackGeometry(dataset({ instanceNumber: n }, axial)))), [1, 2, 0]);
  // A localiser repeated at one position must not scramble.
  assert.deepEqual(
    stackOrder([2, 1].map((n) => stackGeometry(dataset({ instanceNumber: n, position: [0, 0, 5] }, axial)))),
    [1, 0]
  );
  assert.deepEqual(stackOrder([{ position: null, instanceNumber: null }, { position: null, instanceNumber: null }]), [0, 1]);
  // Oblique planes project onto their own normal.
  const oblique = [1, 0, 0, 0, Math.SQRT1_2, -Math.SQRT1_2];
  const g = stackGeometry(dataset({ position: [0, 1, 1] }, oblique));
  // normal = row × column = (0, √½, √½); [0, 1, 1] · normal = √2.
  assert.ok(Math.abs(g.position! - Math.SQRT2) < 1e-9, String(g.position));
});
