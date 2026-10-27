import assert from "node:assert/strict";
import test from "node:test";
import { viewportIdFor } from "./compareViewport.ts";
import {
  MIN_MPR_SLICES,
  assessMpr,
  cameraLookingAt,
  modalityAllowsMpr,
  modalityForMpr,
  mprVolumeId,
  mprVolumeKey,
  mprViewportIds,
  nearestSliceIndex,
  nextMprAction,
  sliceCenterPatient,
  type PlaneSample,
} from "./mpr.ts";

function axial(z: number, patch: Partial<PlaneSample> = {}): PlaneSample {
  return {
    imagePositionPatient: [0, 0, z],
    imageOrientationPatient: [1, 0, 0, 0, 1, 0],
    rows: 64,
    columns: 64,
    pixelSpacing: [0.8, 0.8],
    rowPixelSpacing: 0.8,
    columnPixelSpacing: 0.8,
    usingDefaultValues: false,
    ...patch,
  };
}

function volume(count = MIN_MPR_SLICES, step = 1.25): PlaneSample[] {
  return Array.from({ length: count }, (_, i) => axial(i * step));
}

test("CT and MR can reconstruct; radiographs cannot", () => {
  assert.equal(modalityAllowsMpr("CT"), true);
  assert.equal(modalityAllowsMpr("mr"), true);
  assert.equal(modalityAllowsMpr("MRI"), true);
  assert.equal(modalityAllowsMpr(""), true);
  assert.equal(modalityAllowsMpr(undefined), true);
  assert.equal(modalityAllowsMpr("CR"), false);
  assert.equal(modalityAllowsMpr("DX"), false);
  assert.equal(modalityAllowsMpr("US"), false);
  assert.equal(modalityForMpr(undefined, "MR", "CT"), "MR");
  assert.equal(modalityForMpr("  ", null, "CT"), "CT");
});

test("a regular CT volume passes and a short series does not", () => {
  assert.equal(assessMpr(volume(), { modality: "CT" }).ok, true);
  const short = assessMpr(volume(MIN_MPR_SLICES - 1), { modality: "CT" });
  assert.equal(short.ok, false);
  if (!short.ok) {
    assert.equal(short.reason, "count");
    assert.match(short.message, /stack view stays on/i);
  }
});

test("modality, missing anchors, and uneven spacing each explain themselves", () => {
  const radiograph = assessMpr(volume(), { modality: "DX" });
  assert.equal(radiograph.ok, false);
  if (!radiograph.ok) assert.equal(radiograph.reason, "modality");

  const invented = volume();
  invented[3] = axial(3, { usingDefaultValues: true, imagePositionPatient: [0, 0, 0] });
  const geometry = assessMpr(invented, { modality: "MR" });
  assert.equal(geometry.ok, false);
  if (!geometry.ok) assert.equal(geometry.reason, "geometry");

  const unspaced = volume();
  unspaced[0] = axial(0, { pixelSpacing: undefined, rowPixelSpacing: 1, columnPixelSpacing: 1 });
  const pixels = assessMpr(unspaced, { modality: "CT" });
  assert.equal(pixels.ok, false);
  if (!pixels.ok) assert.equal(pixels.reason, "pixels");

  const gap = volume();
  gap[gap.length - 1] = axial(500);
  const spacing = assessMpr(gap, { modality: "CT" });
  assert.equal(spacing.ok, false);
  if (!spacing.ok) assert.equal(spacing.reason, "spacing");
});

test("slice center uses the image anchor and refuses a defaulted plane", () => {
  const center = sliceCenterPatient(axial(10, { rows: 4, columns: 4, pixelSpacing: [2, 2] }));
  assert.ok(center);
  assert.ok(Math.abs(center[0] - 3) < 1e-6);
  assert.ok(Math.abs(center[1] - 3) < 1e-6);
  assert.ok(Math.abs(center[2] - 10) < 1e-6);
  assert.equal(sliceCenterPatient(axial(0, { usingDefaultValues: true })), null);
  assert.equal(sliceCenterPatient(axial(0, { imagePositionPatient: undefined })), null);
  assert.equal(sliceCenterPatient(null), null);
});

test("camera keeps its viewing offset and points at the authored center", () => {
  const next = cameraLookingAt(
    { focalPoint: [0, 0, 0], position: [0, 0, 500], viewPlaneNormal: [0, 0, 1] },
    [10, 20, 30]
  );
  assert.deepEqual(next, {
    focalPoint: [10, 20, 30],
    position: [10, 20, 530],
  });
  assert.equal(cameraLookingAt({ focalPoint: [1] }, [0, 0, 0]), null);
});

test("nearest slice ignores images with no anchor", () => {
  const slices = [
    { index: 0, center: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] },
    { index: 1, center: null, normal: null },
    { index: 2, center: [0, 0, 10] as [number, number, number], normal: [0, 0, 1] as [number, number, number] },
  ];
  assert.equal(nearestSliceIndex([0, 0, 9], slices), 2);
  assert.equal(nearestSliceIndex([0, 0, 1], slices), 0);
  assert.equal(nearestSliceIndex([0, 0, 0], [{ index: 4, center: null, normal: null }]), null);
});

test("MPR viewport ids stay off the stack viewport", () => {
  const ids = mprViewportIds("primary");
  assert.equal(ids.axial, "FLOWRAD_MPR_primary_axial");
  assert.notEqual(ids.axial, viewportIdFor("primary"));
  assert.notEqual(ids.coronal, ids.sagittal);
  const key = mprVolumeKey(["a", "b", "c"]);
  assert.equal(mprVolumeId("primary", ["a", "b", "c"]), `cornerstoneStreamingImageVolume:flowrad-primary-${key}`);
  assert.equal(mprVolumeKey(["a", "b", "c"]), key);
});

test("series changes mount, replace, or fall back without leaving a stale volume", () => {
  assert.equal(
    nextMprAction({ mode: "stack", session: false, canReconstruct: true, volumeKey: "a", loadedKey: null }),
    "idle"
  );
  assert.equal(
    nextMprAction({ mode: "stack", session: true, canReconstruct: true, volumeKey: "a", loadedKey: "a" }),
    "teardown"
  );
  assert.equal(
    nextMprAction({ mode: "mpr", session: false, canReconstruct: false, volumeKey: null, loadedKey: null }),
    "fallback"
  );
  assert.equal(
    nextMprAction({ mode: "mpr", session: false, canReconstruct: true, volumeKey: "a", loadedKey: null }),
    "mount"
  );
  assert.equal(
    nextMprAction({ mode: "mpr", session: true, canReconstruct: true, volumeKey: "b", loadedKey: "a" }),
    "replace"
  );
  assert.equal(
    nextMprAction({ mode: "mpr", session: true, canReconstruct: true, volumeKey: "a", loadedKey: "a" }),
    "idle"
  );
});
