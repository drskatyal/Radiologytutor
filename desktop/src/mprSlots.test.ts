// MPR three-box layout: plane dropdowns swap, never duplicate. Run: npm --prefix desktop test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_MPR_SLOTS,
  MPR_SLOT_CLASSES,
  assignMprSlot,
  parseMprSlots,
} from "./viewer/mprSlots";

test("mpr layout: three boxes, axial tall by default, coronal and sagittal stacked", () => {
  assert.deepEqual(DEFAULT_MPR_SLOTS, ["axial", "coronal", "sagittal"]);
  assert.equal(MPR_SLOT_CLASSES.length, 3);
  assert.match(MPR_SLOT_CLASSES[0], /row-span-2/);
});

test("mpr layout: picking a plane another box shows swaps the two", () => {
  assert.deepEqual(assignMprSlot(DEFAULT_MPR_SLOTS, 0, "coronal"), [
    "coronal",
    "axial",
    "sagittal",
  ]);
  assert.deepEqual(assignMprSlot(DEFAULT_MPR_SLOTS, 2, "axial"), [
    "sagittal",
    "coronal",
    "axial",
  ]);
  assert.equal(
    assignMprSlot(DEFAULT_MPR_SLOTS, 1, "coronal"),
    DEFAULT_MPR_SLOTS,
    "same plane: unchanged",
  );
  assert.equal(
    assignMprSlot(DEFAULT_MPR_SLOTS, 3, "axial"),
    DEFAULT_MPR_SLOTS,
    "no fourth box",
  );
  for (const i of [0, 1, 2]) {
    for (const p of ["axial", "coronal", "sagittal"] as const) {
      assert.equal(
        new Set(assignMprSlot(DEFAULT_MPR_SLOTS, i, p)).size,
        3,
        `box ${i} → ${p} keeps every plane`,
      );
    }
  }
});

test("mpr layout: only a stored permutation of the three planes is restored", () => {
  assert.deepEqual(parseMprSlots('["sagittal","axial","coronal"]'), [
    "sagittal",
    "axial",
    "coronal",
  ]);
  assert.equal(parseMprSlots('["axial","axial","coronal"]'), null);
  assert.equal(parseMprSlots('["axial","coronal"]'), null);
  assert.equal(parseMprSlots('["axial","coronal","oblique"]'), null);
  assert.equal(parseMprSlots("not json"), null);
  assert.equal(parseMprSlots(null), null);
});

test("mpr view: no empty fourth box, a dropdown per box and a close (X) button", () => {
  const src = readFileSync(
    new URL("./viewer/NativeMprView.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/grid-cols-2 grid-rows-2/.test(src),
    "the old 2×2 grid with an empty box is gone",
  );
  assert.match(src, /aria-label="Close MPR"/);
  assert.match(src, /aria-label=\{`Plane in \$\{/);
});
