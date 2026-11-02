import { test } from "node:test";
import assert from "node:assert/strict";
import { filterTagRows, isIdentifyingTag, tagRows, type TagDataSet } from "../packages/viewer-core/src/dicomTags.ts";

const ds: TagDataSet = {
  elements: {
    x00100010: { tag: "x00100010", vr: "PN", length: 8 },
    x00080060: { tag: "x00080060", vr: "CS", length: 2 },
    x00280010: { tag: "x00280010", vr: "US", length: 2 },
    x00091001: { tag: "x00091001", vr: "LO", length: 4 },
    x00081140: { tag: "x00081140", vr: "SQ", length: 0, items: [{}, {}] },
    x7fe00010: { tag: "x7fe00010", vr: "OW", length: 524288 },
  },
  string: (t) => ({ x00100010: "DOE^JANE", x00080060: "CT", x00091001: "ABCD" })[t],
  uint16: (t) => (t === "x00280010" ? 512 : undefined),
};

test("tags: names, values by VR, sequences, pixel data size, in tag order", () => {
  const rows = tagRows(ds);
  assert.deepEqual(rows.map((r) => r.tag), ["(0008,0060)", "(0008,1140)", "(0009,1001)", "(0010,0010)", "(0028,0010)", "(7FE0,0010)"]);
  const by = (t: string) => rows.find((r) => r.tag === t)!;
  assert.equal(by("(0008,0060)").name, "Modality");
  assert.equal(by("(0008,0060)").value, "CT");
  assert.equal(by("(0028,0010)").value, "512");
  assert.equal(by("(0008,1140)").value, "Sequence · 2 items");
  assert.equal(by("(0009,1001)").name, "Private tag");
  assert.match(by("(7FE0,0010)").value, /524.288 bytes/);
});

test("tags: identifying values are masked when patient details are hidden", () => {
  assert.ok(isIdentifyingTag("00100010") && isIdentifyingTag("x00080080") && !isIdentifyingTag("00080060"));
  const rows = tagRows(ds, { hideIdentifying: true });
  assert.equal(rows.find((r) => r.tag === "(0010,0010)")!.value, "(hidden)");
  assert.equal(rows.find((r) => r.tag === "(0008,0060)")!.value, "CT");
});

test("tags: search by tag, name or value", () => {
  const rows = tagRows(ds);
  assert.deepEqual(filterTagRows(rows, "0028,0010").map((r) => r.name), ["Rows"]);
  assert.deepEqual(filterTagRows(rows, "modality").map((r) => r.tag), ["(0008,0060)"]);
  assert.deepEqual(filterTagRows(rows, "doe").map((r) => r.tag), ["(0010,0010)"]);
  assert.equal(filterTagRows(rows, "").length, rows.length);
});
