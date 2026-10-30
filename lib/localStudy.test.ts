import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DICM_PREAMBLE_OFFSET,
  compareFileNames,
  describeLocalSeries,
  groupLocalStudies,
  hasDicomMagic,
  imageIdsForInstance,
  instanceImageCount,
  isDicomDir,
  isObviouslyNotDicom,
  sliceNormal,
  slicePosition,
  sortSeriesInstances,
  type LocalInstanceHeader,
} from "./localStudy";

function header(over: Partial<LocalInstanceHeader> = {}): LocalInstanceHeader {
  return {
    fileName: "IM000001",
    sizeBytes: 1024,
    studyInstanceUID: "1.2.3",
    seriesInstanceUID: "1.2.3.4",
    sopInstanceUID: "1.2.3.4.5",
    modality: "CT",
    ...over,
  };
}

function withPreamble(magic: string, at = DICM_PREAMBLE_OFFSET): Uint8Array {
  const bytes = new Uint8Array(at + 8);
  for (let i = 0; i < magic.length; i += 1) bytes[at + i] = magic.charCodeAt(i);
  return bytes;
}

test("DICM at offset 128 is recognised", () => {
  assert.equal(hasDicomMagic(withPreamble("DICM")), true);
});

test("a preamble-less DICM at offset 0 is recognised", () => {
  assert.equal(hasDicomMagic(withPreamble("DICM", 0)), true);
});

test("a JPEG or an empty file is not DICOM", () => {
  assert.equal(hasDicomMagic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), false);
  assert.equal(hasDicomMagic(new Uint8Array()), false);
  assert.equal(hasDicomMagic(withPreamble("DICX")), false);
});

test("DICOMDIR is an index, in any case and at any depth", () => {
  assert.equal(isDicomDir("DICOMDIR"), true);
  assert.equal(isDicomDir("dicomdir"), true);
  assert.equal(isDicomDir("CD1/DICOMDIR"), true);
  assert.equal(isDicomDir("D:\\CD1\\DICOMDIR"), true);
  assert.equal(isDicomDir("DICOM/IM000001"), false);
});

test("the obvious non-DICOM files on a study CD are skipped", () => {
  for (const name of [
    "autorun.inf",
    "Viewer.exe",
    "readme.txt",
    "report.pdf",
    "logo.png",
    ".DS_Store",
    "Thumbs.db",
    "DICOM/vendor/qt5core.dll",
  ]) {
    assert.equal(isObviouslyNotDicom(name), true, name);
  }
});

test("extensionless image files are never skipped", () => {
  for (const name of ["IM000001", "I10", "0001", "DICOM/ST0/SE1/IM42", "scan.dcm"]) {
    assert.equal(isObviouslyNotDicom(name), false, name);
  }
});

test("file names sort naturally, so IM9 precedes IM10", () => {
  const sorted = ["IM10", "IM9", "IM100", "IM1"].sort(compareFileNames);
  assert.deepEqual(sorted, ["IM1", "IM9", "IM10", "IM100"]);
});

test("the slice normal is the cross product of the orientation cosines", () => {
  assert.deepEqual(sliceNormal([1, 0, 0, 0, 1, 0]), [0, 0, 1], "axial");
  assert.deepEqual(sliceNormal([1, 0, 0, 0, 0, -1]), [0, 1, 0], "coronal");
  assert.equal(sliceNormal(undefined), null);
  assert.equal(sliceNormal([1, 0, 0]), null, "too short");
  assert.equal(sliceNormal([1, 0, 0, 1, 0, 0]), null, "degenerate — parallel cosines");
  assert.equal(sliceNormal([1, 0, 0, 0, Number.NaN, 0]), null);
});

test("slice position needs both an orientation and a position", () => {
  assert.equal(
    slicePosition(header({ imageOrientationPatient: [1, 0, 0, 0, 1, 0], imagePositionPatient: [0, 0, 17.5] })),
    17.5
  );
  assert.equal(slicePosition(header({ imagePositionPatient: [0, 0, 17.5] })), null);
  assert.equal(slicePosition(header({ imageOrientationPatient: [1, 0, 0, 0, 1, 0] })), null);
});

test("a positioned axial series sorts along the normal, not by file name", () => {
  const axial = [1, 0, 0, 0, 1, 0];
  const instances = [
    header({ fileName: "IM3", imageOrientationPatient: axial, imagePositionPatient: [0, 0, 30], instanceNumber: 3 }),
    header({ fileName: "IM1", imageOrientationPatient: axial, imagePositionPatient: [0, 0, 10], instanceNumber: 1 }),
    header({ fileName: "IM2", imageOrientationPatient: axial, imagePositionPatient: [0, 0, 20], instanceNumber: 2 }),
  ];
  assert.deepEqual(
    sortSeriesInstances(instances).map((i) => i.fileName),
    ["IM1", "IM2", "IM3"]
  );
});

test("position wins even when InstanceNumber disagrees with it", () => {
  const axial = [1, 0, 0, 0, 1, 0];
  const instances = [
    header({ fileName: "a", imageOrientationPatient: axial, imagePositionPatient: [0, 0, 10], instanceNumber: 99 }),
    header({ fileName: "b", imageOrientationPatient: axial, imagePositionPatient: [0, 0, 20], instanceNumber: 1 }),
  ];
  assert.deepEqual(
    sortSeriesInstances(instances).map((i) => i.fileName),
    ["a", "b"]
  );
});

test("a degenerate position set falls back to InstanceNumber", () => {
  const axial = [1, 0, 0, 0, 1, 0];
  const instances = [
    header({ fileName: "z", imageOrientationPatient: axial, imagePositionPatient: [0, 0, 5], instanceNumber: 2 }),
    header({ fileName: "a", imageOrientationPatient: axial, imagePositionPatient: [0, 0, 5], instanceNumber: 1 }),
  ];
  assert.deepEqual(
    sortSeriesInstances(instances).map((i) => i.fileName),
    ["a", "z"]
  );
});

test("with no positions and no instance numbers, file name order holds", () => {
  const instances = [header({ fileName: "IM10" }), header({ fileName: "IM9" })];
  assert.deepEqual(
    sortSeriesInstances(instances).map((i) => i.fileName),
    ["IM9", "IM10"]
  );
});

test("an instance with a number sorts ahead of one without", () => {
  const instances = [header({ fileName: "b" }), header({ fileName: "a", instanceNumber: 7 })];
  assert.deepEqual(
    sortSeriesInstances(instances).map((i) => i.fileName),
    ["a", "b"]
  );
});

test("multiframe instances count every frame", () => {
  assert.equal(instanceImageCount(header()), 1);
  assert.equal(instanceImageCount(header({ numberOfFrames: 1 })), 1);
  assert.equal(instanceImageCount(header({ numberOfFrames: 96 })), 96);
  assert.equal(instanceImageCount(header({ numberOfFrames: 0 })), 1, "0 frames is still one image");
  assert.equal(instanceImageCount(header({ numberOfFrames: Number.NaN })), 1);
});

test("headers group into studies, then series ordered by series number", () => {
  const studies = groupLocalStudies([
    header({ fileName: "a", seriesInstanceUID: "s2", seriesNumber: 2, modality: "CT" }),
    header({ fileName: "b", seriesInstanceUID: "s1", seriesNumber: 1, modality: "CT" }),
    header({ fileName: "c", seriesInstanceUID: "s1", seriesNumber: 1, modality: "CT" }),
  ]);
  assert.equal(studies.length, 1);
  assert.deepEqual(studies[0].series.map((s) => s.seriesInstanceUID), ["s1", "s2"]);
  assert.equal(studies[0].series[0].instances.length, 2);
  assert.equal(studies[0].imageCount, 3);
});

test("two studies on one disc stay separate, newest first", () => {
  const studies = groupLocalStudies([
    header({ fileName: "old", studyInstanceUID: "A", studyDate: "20240101", seriesInstanceUID: "a1" }),
    header({ fileName: "new", studyInstanceUID: "B", studyDate: "20260101", seriesInstanceUID: "b1" }),
  ]);
  assert.deepEqual(studies.map((s) => s.studyInstanceUID), ["B", "A"], "newest study leads");
});

test("files with unreadable identity are still openable, not dropped", () => {
  const studies = groupLocalStudies([
    header({ fileName: "DICOM/SE1/IM1", studyInstanceUID: undefined, seriesInstanceUID: undefined }),
    header({ fileName: "DICOM/SE2/IM1", studyInstanceUID: undefined, seriesInstanceUID: undefined }),
  ]);
  assert.equal(studies.length, 1);
  assert.equal(studies[0].series.length, 2, "grouped by folder");
  assert.equal(studies[0].imageCount, 2);
});

test("grouping an empty drop yields no studies rather than a blank one", () => {
  assert.deepEqual(groupLocalStudies([]), []);
});

test("a series description is an honest one-liner", () => {
  const [study] = groupLocalStudies([
    header({ seriesDescription: "Chest w/o contrast", numberOfFrames: 240 }),
  ]);
  assert.equal(describeLocalSeries(study.series[0]), "CT · 240 images · Chest w/o contrast");
  const [bare] = groupLocalStudies([header({ modality: undefined, seriesDescription: undefined })]);
  assert.equal(describeLocalSeries(bare.series[0]), "DICOM · 1 image");
});

test("a single-frame instance is one imageId, untouched", () => {
  assert.deepEqual(imageIdsForInstance("dicomfile:7", 1), ["dicomfile:7"]);
  assert.deepEqual(imageIdsForInstance("dicomfile:7", 0), ["dicomfile:7"]);
  assert.deepEqual(imageIdsForInstance("dicomfile:7", Number.NaN), ["dicomfile:7"]);
});

test("a multiframe instance fans out to 1-based frame ids", () => {
  assert.deepEqual(imageIdsForInstance("dicomfile:3", 4), [
    "dicomfile:3?frame=1",
    "dicomfile:3?frame=2",
    "dicomfile:3?frame=3",
    "dicomfile:3?frame=4",
  ]);
});

test("every frame of a long cine loop is present exactly once", () => {
  const ids = imageIdsForInstance("dicomfile:1", 96);
  assert.equal(ids.length, 96);
  assert.equal(new Set(ids).size, 96);
  assert.ok(ids[0].endsWith("frame=1"), "the first frame is 1, not 0");
  assert.ok(ids[95].endsWith("frame=96"), "the last frame is included");
});
