import { strict as assert } from "node:assert";
import { test } from "node:test";
import dicomParser from "dicom-parser";
import { syntheticDicomBytes } from "../packages/viewer-core/src/syntheticDicom";

// The prewarm's synthetic file must be a valid Part 10 dataset the real
// loader accepts, and carry nothing that identifies a person.

for (const kind of ["ct", "mr"] as const) {
  test(`synthetic ${kind} DICOM parses as a 16×16 16-bit image`, () => {
    const bytes = syntheticDicomBytes({ kind });
    const ds = dicomParser.parseDicom(bytes);
    assert.equal(ds.string("x00020010"), "1.2.840.10008.1.2.1");
    assert.equal(ds.uint16("x00280010"), 16);
    assert.equal(ds.uint16("x00280011"), 16);
    assert.equal(ds.uint16("x00280100"), 16);
    assert.equal(ds.uint16("x00280103"), kind === "ct" ? 1 : 0);
    assert.equal(ds.string("x00080060"), kind === "ct" ? "CT" : "MR");
    assert.equal(ds.elements.x7fe00010.length, 16 * 16 * 2);
    if (kind === "ct") assert.equal(ds.floatString("x00281052"), -1024);
    // No patient module at all.
    for (const tag of ["x00100010", "x00100020", "x00100030", "x00080090"]) assert.equal(ds.elements[tag], undefined);
  });
}
