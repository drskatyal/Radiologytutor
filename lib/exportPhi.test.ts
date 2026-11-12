import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDicom } from "dicom-parser";
import { anonymousLines, exportBaseName } from "./viewerExport";
import { captureViewport, exportBaseName as desktopName } from "../desktop/src/viewer/exporter";
import { safeExportLines } from "./exportText";
import { anonymizeInstance, assertDicomExportSafe } from "./dicomAnonymize";
import { EXPORT_DICOM_TAGS } from "./exportDicomTags";
import { PhiError } from "./phiGuard";
import { inventoryFromMetadata } from "./findingInventory";

function element(tag: string, vr: string, value: string | Buffer): Buffer {
  let bytes = typeof value === "string" ? Buffer.from(value) : value;
  if (bytes.length % 2) bytes = Buffer.concat([bytes, Buffer.from([vr === "UI" ? 0 : 32])]);
  const long = ["SQ", "OW", "OB", "UN"].includes(vr), header = Buffer.alloc(long ? 12 : 8);
  header.writeUInt16LE(parseInt(tag.slice(0, 4), 16), 0); header.writeUInt16LE(parseInt(tag.slice(4), 16), 2); header.write(vr, 4);
  if (long) header.writeUInt32LE(bytes.length, 8); else header.writeUInt16LE(bytes.length, 6);
  return Buffer.concat([header, bytes]);
}
function sequence(tag: string, items: Buffer[]): Buffer {
  return element(tag, "SQ", Buffer.concat(items.map(bytes => { const item = Buffer.alloc(8); item.writeUInt16LE(0xfffe, 0); item.writeUInt16LE(0xe000, 2); item.writeUInt32LE(bytes.length, 4); return Buffer.concat([item, bytes]); })));
}
function syntheticDirtyDicom(): Buffer {
  const preamble = Buffer.alloc(132); preamble.write("SYNTHETIC DIRTY PREAMBLE DOE^JANE"); preamble.write("DICM", 128);
  return Buffer.concat([preamble, element("00020010", "UI", "1.2.840.10008.1.2.1"),
    element("00080016", "UI", "1.2.840.10008.5.1.4.1.1.2"), element("00080018", "UI", "1.2.3.4"),
    element("00080050", "SH", "ACC12345"), element("00080060", "CS", "CT"), element("00080090", "PN", "DOE^JANE"),
    element("00081030", "LO", "SYNTHETIC UNSAFE FREE TEXT"),
    element("00100010", "PN", "DOE^JANE"), element("00100020", "LO", "ACC12345"), element("00100030", "DA", "19700101"),
    element("0020000D", "UI", "1.2.3"), element("0020000E", "UI", "1.2.3.1"),
    sequence("52009230", [Buffer.concat([
      element("00100010", "PN", "DOE^JANE"),
      sequence("00209113", [element("00200032", "DS", "0\\0\\3")]),
      sequence("00289110", [element("00280030", "DS", "0.7\\0.9")]),
    ])]), element("7FE00010", "OW", Buffer.from([1, 0, 2, 0]))]);
}

test("web and desktop labels use the same metadata allowlist and reject identity text", async () => {
  for (const modality of ["DOE^JANE", "Patient ID: ACC12345", "JANE"]) {
    assert.throws(() => anonymousLines({ modality, index: 0, count: 1 }), PhiError);
    assert.throws(() => exportBaseName({ modality }), PhiError);
    assert.throws(() => desktopName({ modality }), PhiError);
  }
  assert.throws(() => anonymousLines({ modality: "CT", seriesNumber: "ACC12345", index: 0, count: 1 }), PhiError);
  assert.throws(() => safeExportLines({ anonymous: ["CT"], identifying: ["Synthetic Dirty Identity"] }), PhiError);
  // Even a legacy full-overlay request fails before touching a DOM/canvas.
  await assert.rejects(captureViewport({} as HTMLElement, { overlay: "full", annotations: false, text: { anonymous: ["CT"], identifying: ["DOE^JANE"] } }), PhiError);
  assert.deepEqual(safeExportLines({ anonymous: ["CT · Se 1"], identifying: ["ANONYMOUS"] }), ["CT · Se 1"]);
});
test("DICOM export strips five identity families, unknown metadata and nested identifiers, preserving geometry and pixels", () => {
  const raw = syntheticDirtyDicom();
  assert.throws(() => assertDicomExportSafe(raw));
  const result = anonymizeInstance(raw, { uidSalt: "synthetic-export-test" });
  assert.doesNotThrow(() => assertDicomExportSafe(result.bytes));
  const parsed = parseDicom(result.bytes);
  for (const tag of ["x00100010", "x00100020", "x00100030", "x00080050", "x00080090", "x00081030"]) assert.ok(!parsed.string(tag), tag);
  const nested = parsed.elements.x52009230.items![0].dataSet!;
  assert.ok(!nested.string("x00100010"));
  assert.equal(nested.elements.x00209113.items![0].dataSet!.string("x00200032"), "0\\0\\3");
  assert.equal(nested.elements.x00289110.items![0].dataSet!.string("x00280030"), "0.7\\0.9");
  const pixels = parsed.elements.x7fe00010;
  assert.deepEqual(Buffer.from(result.bytes.slice(pixels.dataOffset, pixels.dataOffset + pixels.length)), Buffer.from([1, 0, 2, 0]));
  assert.doesNotMatch(Buffer.from(result.bytes).toString("latin1"), /DOE\^JANE|ACC12345|19700101|UNSAFE FREE TEXT/);
});
test("native and web export allowlists stay identical", () => {
  const source = readFileSync("desktop/src-tauri/src/export_policy.rs", "utf8");
  const list = source.split("pub const ALLOWED_TAGS")[1].split("];", 1)[0];
  const rust = [...list.matchAll(/0x([0-9A-F]{8})/g)].map(m => m[1]);
  assert.deepEqual(rust.sort(), [...EXPORT_DICOM_TAGS].sort());
});
test("dirty archive metadata cannot be used to approve a finding", () => {
  const dirty = JSON.parse(readFileSync("fixtures/synthetic/dirty-metadata.json", "utf8"));
  assert.throws(() => inventoryFromMetadata({ studyUID: "1", seriesUID: "2", sopUID: "3", frame: 1, view: {} }, [dirty]), PhiError);
});
test("publication requires pixel, audio and screen review even with a study reference", async () => {
  const { assertCasePublishable } = await import("./cases");
  const data = JSON.parse(readFileSync("fixtures/synthetic/case.json", "utf8"));
  await assert.rejects(assertCasePublishable(data), PhiError);
});
test("Gemini request boundary rejects identifier text before provider transport", async () => {
  const { generate } = await import("./gemini");
  const original = globalThis.fetch;
  let calls = 0;
  process.env.GEMINI_API_KEY = "unit-test-only-mock";
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected model transport"); };
  try {
    await assert.rejects(generate({ contents: [{ role: "user", parts: [{ text: "Patient ID: ACC12345" }] }] }), PhiError);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; delete process.env.GEMINI_API_KEY; }
});
