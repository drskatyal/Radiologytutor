import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseDicom } from "dicom-parser";
import { evaluateDeid, inspectDicomBytes } from "../deid.ts";
import { AnonymizeError, BLOCKING_TAG_HEX, STRIP_TAGS, anonymizeInstance, remapUid } from "./anonymize.ts";
import { sha256 } from "./sha256.ts";

const RAW = join(process.cwd(), "public/dicom/emri_small.dcm");
const SALT = "account-salt-a";

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pixelBytes(bytes: Uint8Array): Uint8Array {
  const el = parseDicom(bytes).elements.x7fe00010;
  assert.ok(el, "pixel data element");
  return bytes.slice(el.dataOffset, el.dataOffset + el.length);
}

test("sha256 matches node:crypto", () => {
  for (const input of ["", "abc", "x".repeat(55), "y".repeat(56), "z".repeat(200)]) {
    const want = createHash("sha256").update(input).digest("hex");
    assert.equal(Buffer.from(sha256(new TextEncoder().encode(input))).toString("hex"), want, `len ${input.length}`);
  }
});

test("strip set covers every blocking identity tag", () => {
  for (const hex of Object.values(BLOCKING_TAG_HEX)) assert.equal(STRIP_TAGS.has(hex), true, hex);
});

test("remapUid is stable per salt, differs across salts, and is a valid 2.25 UID", () => {
  const original = "1.2.826.0.1.3680043.2.1143.6455556726214900995651753669640998622";
  const a = remapUid(original, SALT);
  assert.equal(a, remapUid(original, SALT));
  assert.notEqual(a, remapUid(original, "account-salt-b"));
  assert.match(a, /^2\.25\.[1-9][0-9]*$/);
  assert.ok(a.length <= 64);
  assert.throws(() => remapUid(original, ""), AnonymizeError);
});

test("emri_small.dcm passes the server identity gate after anonymising, pixels unchanged", () => {
  const raw = new Uint8Array(readFileSync(RAW));
  const before = parseDicom(raw);
  assert.equal(evaluateDeid(inspectDicomBytes(ab(raw))).pass, false);

  const out = anonymizeInstance(raw, { uidSalt: SALT });
  const after = parseDicom(out.bytes);
  assert.equal(evaluateDeid(inspectDicomBytes(ab(out.bytes))).pass, true);
  assert.equal(after.string("x00100030"), undefined);
  assert.equal(after.string("x00120062"), "YES");
  assert.match(after.string("x00120063") ?? "", /pixels not inspected/);
  assert.equal(after.string("x00080060"), "MR");
  assert.equal(after.string("x00080020"), before.string("x00080020"), "dates kept by default");
  assert.deepEqual(pixelBytes(out.bytes), pixelBytes(raw));
  assert.equal(after.string("x0020000d"), remapUid(before.string("x0020000d")!, SALT));
  assert.equal(after.string("x00020003"), after.string("x00080018"));

  // Elements stay in ascending tag order (inserts landed in place).
  const tags = Object.keys(after.elements).filter((t) => !t.startsWith("x0002"));
  assert.deepEqual(tags, [...tags].sort());

  // Idempotent: anonymising again still passes and keeps one PatientIdentityRemoved.
  const again = anonymizeInstance(out.bytes, { uidSalt: SALT });
  assert.equal(evaluateDeid(inspectDicomBytes(ab(again.bytes))).pass, true);
  assert.equal(parseDicom(again.bytes).string("x00120062"), "YES");
});

test("removeDates blanks study and series dates", () => {
  const raw = new Uint8Array(readFileSync(RAW));
  const out = anonymizeInstance(raw, { uidSalt: SALT, removeDates: true });
  const after = parseDicom(out.bytes);
  assert.equal(after.string("x00080020"), undefined);
});

test("non-DICOM input fails closed", () => {
  assert.throws(() => anonymizeInstance(new Uint8Array(200), { uidSalt: SALT }), AnonymizeError);
});
