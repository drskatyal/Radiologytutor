import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseLocalHeader, type DicomHeaderParser, type ParsedDataSet } from "./localDicomFiles";
import { DICM_PREAMBLE_OFFSET } from "./localStudy";

// `openLocalFiles` needs `File` and the Cornerstone file manager, so it is not
// reachable from Node. The tag extraction is, because the parser is injected —
// and it is the part that decides whether a local study groups and scrolls
// correctly, so it is worth pinning.

function dicomBytes(): Uint8Array {
  const bytes = new Uint8Array(DICM_PREAMBLE_OFFSET + 8);
  bytes.set([0x44, 0x49, 0x43, 0x4d], DICM_PREAMBLE_OFFSET);
  return bytes;
}

function fakeParser(tags: Record<string, string | number>): DicomHeaderParser {
  const dataSet: ParsedDataSet = {
    string: (tag) => {
      const value = tags[tag];
      return value == null ? undefined : String(value);
    },
    intString: (tag) => {
      const value = tags[tag];
      if (value == null) return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    },
    uint16: (tag) => {
      const value = tags[tag];
      return typeof value === "number" ? value : undefined;
    },
  };
  return { parseDicom: () => dataSet };
}

const FULL = {
  x0020000d: " 1.2.840.1 ",
  x0020000e: "1.2.840.2",
  x00080018: "1.2.840.3",
  x00200013: "42",
  x00200032: "-250.0\\-250.0\\ 17.5",
  x00200037: "1\\0\\0\\0\\1\\0",
  x00080060: "CT",
  x00200011: "3",
  "x0008103e": "Chest w/o contrast",
  x00081030: "CHEST CT",
  x00080020: "20260101",
  x00280008: "1",
  x00280010: 512,
  x00280011: 512,
};

test("a full header maps every tag the grouping needs", () => {
  const header = parseLocalHeader(fakeParser(FULL), "DICOM/IM42", 524_288, dicomBytes());
  assert.ok(header);
  assert.equal(header.fileName, "DICOM/IM42");
  assert.equal(header.sizeBytes, 524_288);
  assert.equal(header.studyInstanceUID, "1.2.840.1", "whitespace trimmed");
  assert.equal(header.seriesInstanceUID, "1.2.840.2");
  assert.equal(header.sopInstanceUID, "1.2.840.3");
  assert.equal(header.instanceNumber, 42);
  assert.deepEqual(header.imagePositionPatient, [-250, -250, 17.5]);
  assert.deepEqual(header.imageOrientationPatient, [1, 0, 0, 0, 1, 0]);
  assert.equal(header.modality, "CT");
  assert.equal(header.seriesNumber, 3);
  assert.equal(header.seriesDescription, "Chest w/o contrast");
  assert.equal(header.studyDescription, "CHEST CT");
  assert.equal(header.studyDate, "20260101");
  assert.equal(header.rows, 512);
  assert.equal(header.columns, 512);
});

test("a file without the DICM magic is rejected before the parser runs", () => {
  let called = false;
  const parser: DicomHeaderParser = {
    parseDicom: () => {
      called = true;
      throw new Error("should not be reached");
    },
  };
  assert.equal(parseLocalHeader(parser, "logo.png", 10, new Uint8Array(200)), null);
  assert.equal(called, false);
});

test("a parser throw on a truncated header yields null, not an exception", () => {
  const parser: DicomHeaderParser = {
    parseDicom: () => {
      throw new Error("premature end of byte stream");
    },
  };
  assert.equal(parseLocalHeader(parser, "IM1", 10, dicomBytes()), null);
});

test("missing optional tags stay undefined rather than becoming NaN or empty strings", () => {
  const header = parseLocalHeader(fakeParser({ x00080018: "1.2.3" }), "IM1", 10, dicomBytes());
  assert.ok(header);
  assert.equal(header.sopInstanceUID, "1.2.3");
  for (const key of [
    "studyInstanceUID",
    "seriesInstanceUID",
    "instanceNumber",
    "imagePositionPatient",
    "imageOrientationPatient",
    "modality",
    "seriesNumber",
    "numberOfFrames",
    "rows",
  ] as const) {
    assert.equal(header[key], undefined, key);
  }
});

test("an empty-string tag is undefined, not an empty UID", () => {
  const header = parseLocalHeader(
    fakeParser({ x0020000d: "   ", x0008103e: "" }),
    "IM1",
    10,
    dicomBytes()
  );
  assert.ok(header);
  assert.equal(header.studyInstanceUID, undefined);
  assert.equal(header.seriesDescription, undefined);
});

test("a non-numeric decimal string contributes no coordinates", () => {
  const header = parseLocalHeader(
    fakeParser({ x00200032: "abc\\def", x00200037: "1\\0\\0\\0\\1\\0" }),
    "IM1",
    10,
    dicomBytes()
  );
  assert.ok(header);
  assert.equal(header.imagePositionPatient, undefined);
  assert.deepEqual(header.imageOrientationPatient, [1, 0, 0, 0, 1, 0]);
});

test("a multiframe count comes through so the frame fan-out is right", () => {
  const header = parseLocalHeader(fakeParser({ x00280008: "96" }), "IM1", 10, dicomBytes());
  assert.equal(header?.numberOfFrames, 96);
});
