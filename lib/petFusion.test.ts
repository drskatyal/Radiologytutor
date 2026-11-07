import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateSUVScalingFactors } from "@cornerstonejs/calculate-suv";
import {
  hasSuvInputs,
  petMetaFromDataSet,
  petOpacityRamp,
  pickFusionPair,
  sanitizePetMeta,
  type PetTagReader,
} from "../packages/viewer-core/src/petFusion.ts";

const reader = (tags: Record<string, string>, info?: Record<string, string>): PetTagReader => ({
  string: (t) => tags[t],
  floatString: (t) => (tags[t] != null ? Number.parseFloat(tags[t]!) : undefined),
  elements: info ? { x00540016: { items: [{ dataSet: reader(info) }] } } : {},
});

// The synthetic study of scripts/make-test-petct.py.
const PET = reader(
  {
    x00280051: "ATTN\\DECY",
    x00541001: "BQML",
    x00541102: "START",
    x00101030: "75",
    x00100040: "O",
    x00080021: "20250101",
    x00080031: "120000",
    x00080022: "20250101",
    x00080032: "120000",
  },
  { x00181074: "370000000", x00181075: "6586.2", x00181072: "110000", x00181078: "20250101110000" }
);

test("SUVbw from a PET header: 1 SUV = 3377.5 Bq/ml for the synthetic study", () => {
  const meta = petMetaFromDataSet(PET);
  assert.ok(hasSuvInputs(meta));
  assert.equal(meta.PatientSex, undefined, "sex 'O' is dropped (calculate-suv throws on it)");
  assert.deepEqual(meta.CorrectedImage, ["ATTN", "DECY"]);
  const [factor] = calculateSUVScalingFactors([meta] as never);
  assert.ok(Math.abs(1 / factor!.suvbw - 3377.5) < 0.5, String(factor!.suvbw));
});

test("missing dose or weight: no SUV, never an invented factor", () => {
  const noDose = petMetaFromDataSet(reader({ x00541001: "BQML", x00101030: "75" }));
  assert.equal(hasSuvInputs(noDose), false);
  assert.equal(hasSuvInputs({}), false);
});

test("sanitizePetMeta drops nulls and empty lists; keeps sex and height only for M/F", () => {
  assert.deepEqual(sanitizePetMeta({ a: null, b: [], c: 1, PatientSex: "F", PatientSize: 1.6 }), { c: 1, PatientSex: "F", PatientSize: 1.6 });
  assert.deepEqual(sanitizePetMeta({ PatientSex: "O", PatientSize: 1.6 }), {});
});

test("pickFusionPair: the active volume, else the largest; same frame of reference first", () => {
  const s = [
    { modality: "CT", imageCount: 300, frameOfReferenceUID: "A" },
    { modality: "PT", imageCount: 200, frameOfReferenceUID: "B" },
    { modality: "CT", imageCount: 150, frameOfReferenceUID: "B" },
    { modality: "PT", imageCount: 3, frameOfReferenceUID: "B" },
    { modality: "MR", imageCount: 100 },
  ];
  assert.deepEqual(pickFusionPair(s, 4), { ct: 0, pt: 1 }, "largest of each");
  assert.deepEqual(pickFusionPair(s, 1), { ct: 2, pt: 1 }, "the CT on the PET's frame");
  assert.deepEqual(pickFusionPair(s, 0), { ct: 0, pt: 1 }, "no PET on frame A: the largest PET");
  assert.equal(pickFusionPair(s.slice(0, 1), 0), null);
  assert.equal(pickFusionPair([{ modality: "CT", imageCount: 50 }, { modality: "PT", imageCount: 5 }]), null, "a 5-slice PET is no volume");
});

test("the overlay ramp keeps background PET transparent in SUV, flat for raw", () => {
  assert.equal(petOpacityRamp(0.6, false), 0.6);
  const ramp = petOpacityRamp(0.6, true) as { value: number; opacity: number }[];
  assert.deepEqual(ramp.map((p) => p.value), [0, 0.5, 1.5, 100]);
  assert.deepEqual(ramp.map((p) => p.opacity), [0, 0, 0.6, 0.6]);
});

test("the ramp converts to raw counts when the volume is not pre-scaled", () => {
  const ramp = petOpacityRamp(0.5, true, 3377.5) as { value: number }[];
  assert.deepEqual(ramp.map((p) => p.value), [0, 1688.75, 5066.25, 337750]);
});

test("suvFactorToApply: only when the loader did not apply SUV itself", async () => {
  const { suvFactorToApply } = await import("../packages/viewer-core/src/petFusion.ts");
  const f = 1 / 3377.5;
  assert.equal(suvFactorToApply({ scaled: true, scalingParameters: { suvbw: f } }, true, f), null, "applied by the loader");
  assert.equal(suvFactorToApply({ scaled: false }, true, f), f, "slope 1 / intercept 0: loader skipped it");
  assert.equal(suvFactorToApply(undefined, true, f), f, "no image record");
  assert.equal(suvFactorToApply({ scaled: true, scalingParameters: { suvbw: f } }, false, f), f, "volume kept raw counts");
  assert.equal(suvFactorToApply({ scaled: false }, true, undefined), null, "no SUV factor at all");
});

test("every PET colour map is a preset the volume viewport resolves", async () => {
  const { PET_COLORMAPS, PET_COLORMAP_LABELS } = await import("../packages/viewer-core/src/petFusion.ts");
  const vtk = await import("@kitware/vtk.js/Rendering/Core/ColorTransferFunction/ColorMaps.js");
  const maps = ((vtk as { default?: unknown }).default ?? vtk) as { getPresetByName(n: string): unknown };
  for (const name of PET_COLORMAPS) {
    assert.ok(maps.getPresetByName(name), `${name} is a vtk.js preset`);
    assert.ok(PET_COLORMAP_LABELS[name]);
  }
});
