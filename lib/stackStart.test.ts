import { test } from "node:test";
import assert from "node:assert/strict";
import { midStackPlane, stackStartIndex } from "../packages/viewer-core/src/stackStart.ts";

const AXIAL = [1, 0, 0, 0, 1, 0];
const CORONAL = [1, 0, 0, 0, 0, -1];
const SAGITTAL = [0, 1, 0, 0, 0, -1];
const OBLIQUE = [1, 0, 0, 0, 0.7071, -0.7071];

test("coronal and sagittal acquisitions open on the middle image", () => {
  assert.equal(stackStartIndex({ imageCount: 47, imageOrientationPatient: CORONAL, modality: "CT" }), 23);
  assert.equal(stackStartIndex({ imageCount: 48, imageOrientationPatient: CORONAL, modality: "MR" }), 24);
  assert.equal(stackStartIndex({ imageCount: 2, imageOrientationPatient: SAGITTAL, modality: "MR" }), 1);
  assert.equal(midStackPlane({ imageCount: 20, imageOrientationPatient: SAGITTAL }), "sagittal");
  // Slightly tilted coronal (gantry / planning) is still coronal.
  assert.equal(stackStartIndex({ imageCount: 30, imageOrientationPatient: [1, 0, 0, 0, 0.1, -0.995], modality: "MR" }), 15);
});

test("axial, oblique, unknown orientation and single images open on image 1", () => {
  assert.equal(stackStartIndex({ imageCount: 300, imageOrientationPatient: AXIAL, modality: "CT" }), 0);
  assert.equal(stackStartIndex({ imageCount: 40, imageOrientationPatient: OBLIQUE, modality: "MR" }), 0);
  assert.equal(stackStartIndex({ imageCount: 40, imageOrientationPatient: undefined, modality: "CT" }), 0);
  assert.equal(stackStartIndex({ imageCount: 40, imageOrientationPatient: [1, 0, 0], modality: "CT" }), 0);
  assert.equal(stackStartIndex({ imageCount: 1, imageOrientationPatient: CORONAL, modality: "CT" }), 0);
  assert.equal(stackStartIndex({ imageCount: 0, imageOrientationPatient: CORONAL }), 0);
});

test("loops keep frame 1: multiframe, a recorded cine rate, US / XA", () => {
  assert.equal(stackStartIndex({ imageCount: 60, imageOrientationPatient: CORONAL, modality: "MR", multiframe: true }), 0);
  assert.equal(stackStartIndex({ imageCount: 60, imageOrientationPatient: SAGITTAL, modality: "MR", frameRate: 25 }), 0);
  assert.equal(stackStartIndex({ imageCount: 60, imageOrientationPatient: CORONAL, modality: "US" }), 0);
  assert.equal(stackStartIndex({ imageCount: 60, imageOrientationPatient: CORONAL, modality: "xa" }), 0);
  assert.equal(midStackPlane({ imageCount: 60, imageOrientationPatient: CORONAL, modality: "XA" }), null);
});
