import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDicom } from "dicom-parser";
import { anonymizeInstance } from "./anonymize.ts";
import { instanceRefusal } from "./ingestGate.ts";
import { parseNewStudy } from "./studyInput.ts";

const raw = new Uint8Array(readFileSync(join(process.cwd(), "public/dicom/emri_small.dcm")));

test("an anonymised instance of the right study passes the gate", () => {
  const anon = anonymizeInstance(raw, { uidSalt: "salt" }).bytes;
  const uid = parseDicom(anon).string("x0020000d")!;
  assert.equal(instanceRefusal(anon, uid), null);
  assert.match(instanceRefusal(anon, "2.25.1") ?? "", /different study/);
});

test("raw (identified) bytes are refused", () => {
  assert.match(instanceRefusal(raw, "1.2.3") ?? "", /identifiers remain/);
});

test("new-study input requires anonymised UIDs and at least one series", () => {
  assert.equal(typeof parseNewStudy({ studyInstanceUID: "1.2.840.1", series: [] }), "string");
  assert.equal(typeof parseNewStudy({ studyInstanceUID: "2.25.12", series: [], bytes: 10 }), "string");
  const ok = parseNewStudy({
    studyInstanceUID: "2.25.12",
    title: "  CT chest  ",
    bytes: 1000,
    series: [{ seriesInstanceUID: "2.25.13", instanceCount: 3, modality: "CT" }, { seriesInstanceUID: "1.2.3", instanceCount: 1 }],
  });
  assert.ok(typeof ok !== "string");
  assert.equal(ok.title, "CT chest");
  assert.equal(ok.series.length, 1);
  assert.equal(ok.instanceCount, 3);
});
