import test from "node:test";
import assert from "node:assert/strict";
import { geometryFromDicom, pixelToPatient, patientToPixel, measuredLength } from "./geometry";
import { plane, markerTrack } from "./fixtures";
import { measurementsFromTrack } from "../findingMeasurements";

test("T8 anisotropic oblique pixel/patient round-trip is within 1e-6 mm, with spacing provenance", () => {
  const c = Math.SQRT1_2;
  for (const spacingTag of ["00280030", "00181164"]) {
    const raw = { ...plane, "00280030": undefined, [spacingTag]: { Value: [0.7, 0.9] }, "00200037": { Value: [c, c, 0, -c, c, 0] } };
    const g = geometryFromDicom(raw, 1), p = { x: 12.345, y: 23.456 };
    assert.equal(g.calibration, spacingTag === "00280030" ? "PixelSpacing" : "ImagerPixelSpacing");
    const world = pixelToPatient(p, g)!; const back = patientToPixel(world, g)!;
    assert.ok(Math.abs(p.x - back.x) < 1e-6 && Math.abs(p.y - back.y) < 1e-6);
    assert.ok(Math.abs(measuredLength([p, { x: p.x + 10, y: p.y }], g)! - 9) < 1e-6);
    assert.equal(patientToPixel([world[0], world[1], world[2] + 1], g), null);
  }
});
test("zero/missing spacing never inherits renderer 1 mm or an alternate spacing", () => {
  for (const spacing of [undefined, { Value: [0, 0.9] }, { Value: [-1, 2] }]) {
    const g = geometryFromDicom({ ...plane, "00280030": spacing }, 1);
    assert.equal(g.calibration, "uncalibrated"); assert.equal(pixelToPatient({ x: 1, y: 2 }, g), null);
    assert.equal(measuredLength([{ x: 0, y: 0 }, { x: 10, y: 0 }], g), null);
  }
  assert.equal(geometryFromDicom({ ...plane, "00280030": { Value: [0, 1] }, "00181164": { Value: [1, 1] } }, 1).calibration, "uncalibrated");
});
test("multiframe 2/3 use distinct per-frame positions, never instance position as a substitute", () => {
  const raw = { ...plane, "00280008": { Value: [4] }, "52009230": { Value: [0, 1.5, 3, 4.5].map(z => ({ "00209113": { Value: [{ "00200032": { Value: [10, 20, z] } }] } })) } };
  const two = geometryFromDicom(raw, 2), three = geometryFromDicom(raw, 3);
  assert.equal(two.positionSource, "per-frame"); assert.equal(pixelToPatient({ x: 0, y: 0 }, two)![2], 1.5);
  assert.equal(pixelToPatient({ x: 0, y: 0 }, three)![2], 3);
  assert.equal(geometryFromDicom({ ...raw, "52009230": undefined }, 2).origin, null);
  assert.equal(geometryFromDicom(raw, 5).calibration, "uncalibrated");
});
test("T8 annotation measurement survives JSON with named SOP/frame, pixels, patient mm and spacing source", () => {
  const track = markerTrack(); const render = track.journal![0];
  track.journal = [render, { seq: 1, t: 20, kind: "annotation", snapshot: render.snapshot, payload: { annotationId: "length-1", event: { type: "annotation", tool: "Length", lengthMm: 999 }, dimensions: [64, 64], imagePoints: [{ x: 10, y: 20 }, { x: 20, y: 20 }], geometry: geometryFromDicom(plane, 1) } }];
  const [measurement] = measurementsFromTrack(JSON.parse(JSON.stringify(track)));
  assert.equal(measurement.lengthMm, 9); assert.equal(measurement.sopInstanceUID, render.snapshot!.sopUID); assert.equal(measurement.frameNumber, 1);
  assert.equal(measurement.resolvedAnchor!.calibration, "PixelSpacing");
  assert.deepEqual(patientToPixel(measurement.resolvedAnchor!.patientPoints![0]!, measurement.resolvedAnchor!.geometry), { x: 10, y: 20 });
  track.journal[1].payload!.geometry = geometryFromDicom({ ...plane, "00280030": undefined }, 1);
  const [uncalibrated] = measurementsFromTrack(track);
  assert.equal(uncalibrated.lengthMm, undefined); assert.equal(uncalibrated.resolvedAnchor!.patientPoint, null);
});

test("original multiframe fixture geometry survives the geometry-only viewer cache", async () => {
  const { readFileSync } = await import("node:fs");
  const { retainImageGeometry, imageGeometry } = await import("./geometryCache");
  const fixture = JSON.parse(readFileSync("fixtures/synthetic/study.json", "utf8"));
  const instance = fixture.instances.find((i: { metadata: Record<string, { Value: number[] }> }) => i.metadata["00280008"]?.Value[0] === 4);
  assert.ok(instance);
  const points = [2, 3].map(frame => {
    const id = `wadors:/synthetic/instances/${instance.sopUID}/frames/${frame}`;
    retainImageGeometry(id, instance.metadata);
    const geometry = imageGeometry(id);
    assert.equal(geometry.positionSource, "per-frame"); assert.equal(geometry.calibration, "PixelSpacing");
    assert.equal(JSON.stringify(geometry).includes("Patient"), false);
    return pixelToPatient({ x: 5, y: 10 }, geometry)!;
  });
  assert.notDeepEqual(points[0], points[1]);
});
