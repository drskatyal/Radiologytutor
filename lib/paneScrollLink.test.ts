import { strict as assert } from "node:assert";
import { test } from "node:test";
import { linkedIndex, offsetAt, planeSign, seriesGeometry, type PaneGeometry } from "./paneScrollLink";
import type { LocalSeries } from "@flowrad/viewer-core";

const AXIAL_IOP = [1, 0, 0, 0, 1, 0];
const SAGITTAL_IOP = [0, 1, 0, 0, 0, -1];

function series(iop: number[], zs: number[], frames = 1): LocalSeries {
  return {
    seriesInstanceUID: "1.2.3",
    instances: zs.map((z, i) => ({
      fileName: `f${i}`,
      imageOrientationPatient: iop,
      imagePositionPatient: [0, 0, z],
      numberOfFrames: frames,
    })),
  } as unknown as LocalSeries;
}

const axial = (zs: number[]) => seriesGeometry(series(AXIAL_IOP, zs))!;

test("geometry: one position per image along the normal; none without orientation", () => {
  const g = axial([0, 2.5, 5]);
  assert.deepEqual(g.normal, [0, 0, 1]);
  assert.deepEqual(g.positions, [0, 2.5, 5]);
  assert.equal(seriesGeometry(series(AXIAL_IOP, [0, 5], 3))!.positions.length, 6, "frames share their instance's position");
  assert.equal(seriesGeometry({ seriesInstanceUID: "x", instances: [{ fileName: "a" }] } as unknown as LocalSeries), null);
  assert.equal(seriesGeometry(null), null);
});

test("same plane, different slice spacing: linked by position, not image number", () => {
  const thin = axial([0, 2.5, 5, 7.5, 10]);
  const thick = axial([0, 5, 10]);
  assert.equal(linkedIndex(thin, 2, thick), 1, "5 mm in the thin series is image 2 of the thick");
  assert.equal(linkedIndex(thin, 4, thick), 2);
  assert.equal(linkedIndex(thick, 1, thin), 2);
});

test("an axial pane never drives a sagittal one", () => {
  const sag = seriesGeometry(series(SAGITTAL_IOP, [0, 1, 2]))!;
  assert.equal(planeSign(axial([0]), sag), 0);
  assert.equal(linkedIndex(axial([0, 1]), 1, sag), null);
});

test("opposite normals (a stack stored feet-first) still link at the same place", () => {
  const up = axial([0, 5, 10]);
  const down: PaneGeometry = { normal: [0, 0, -1], positions: [-10, -5, 0] }; // z = 10, 5, 0
  assert.equal(planeSign(up, down), -1);
  assert.equal(linkedIndex(up, 2, down), 0, "z = 10 is the first image of the reversed stack");
  assert.equal(linkedIndex(up, 0, down), 2);
});

test("a prior is linked at what it shows now, and the offset is kept while scrolling", () => {
  const current = axial([100, 105, 110, 115, 120]);
  const prior = axial([0, 5, 10, 15, 20]);
  // Reader lines them up: current image 1 (105 mm) beside prior image 3 (15 mm).
  const offset = offsetAt(current, 1, prior, 3);
  assert.equal(offset, -90);
  assert.equal(linkedIndex(current, 1, prior, offset), 3, "still level where linked");
  assert.equal(linkedIndex(current, 2, prior, offset), 4, "one step on, one step on");
  assert.equal(linkedIndex(current, 0, prior, offset), 2);
});
