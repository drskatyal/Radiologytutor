import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";
import { parseDicom } from "dicom-parser";
import { BLOCKING_TAG_HEX } from "./anonymizeTeachingDicom.ts";
import { evaluateDeid, inspectDicomBytes } from "./deid.ts";
import { readDicomUids } from "./healthcareDicom.ts";
import {
  TEACHING_DEID_FAILURE,
  TEACHING_STRIP_TAGS,
  TeachingDeidError,
  deidentifyTeachingInstance,
  remapTeachingUid,
} from "./teachingDeidentify.ts";

const RAW = join(process.cwd(), "public/dicom/emri_small.dcm");

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pixelBytes(bytes: Uint8Array): Uint8Array {
  const dataSet = parseDicom(bytes);
  const el = dataSet.elements.x7fe00010;
  assert.ok(el, "pixel data element");
  return bytes.slice(el.dataOffset, el.dataOffset + el.length);
}

test("strip set covers every ingest-blocking identity tag", () => {
  for (const hex of Object.values(BLOCKING_TAG_HEX)) {
    assert.equal(TEACHING_STRIP_TAGS.has(hex), true, hex);
  }
  assert.equal(TEACHING_STRIP_TAGS.has("00080050"), true);
  assert.equal(TEACHING_STRIP_TAGS.has("00080060"), false);
});

test("remapTeachingUid is a stable DICOM UID and does not echo the original", () => {
  const original = "1.2.826.0.1.3680043.2.1143.6455556726214900995651753669640998622";
  const a = remapTeachingUid(original);
  const b = remapTeachingUid(original);
  assert.equal(a, b);
  assert.match(a, /^2\.25\.[1-9][0-9]*$/);
  assert.ok(a.length <= 64);
  assert.notEqual(a, original);
  assert.notEqual(remapTeachingUid(`${original}.2`), a);
});

test("emri_small.dcm loses PatientBirthDate, keeps pixels, and remaps UIDs", () => {
  const raw = new Uint8Array(readFileSync(RAW));
  const before = parseDicom(raw);
  assert.equal(before.string("x00100030"), "20000101");
  assert.equal(evaluateDeid(inspectDicomBytes(asArrayBuffer(raw))).pass, false);

  const cleaned = deidentifyTeachingInstance(raw);
  assert.ok(cleaned.removed.includes("00100030"));
  const after = parseDicom(cleaned.bytes);
  assert.equal(evaluateDeid(inspectDicomBytes(asArrayBuffer(cleaned.bytes))).pass, true);
  assert.equal(after.string("x00100030"), undefined);
  assert.equal(after.string("x00100010"), undefined);
  assert.equal(after.string("x00100020"), undefined);
  assert.equal(after.string("x00080060"), "MR");
  assert.equal(after.string("x00080020"), before.string("x00080020"));
  assert.equal(after.string("x00080016"), before.string("x00080016"));
  assert.equal(after.string("x00020010"), "1.2.840.10008.1.2.1");
  assert.deepEqual(pixelBytes(cleaned.bytes), pixelBytes(raw));

  const rawUids = readDicomUids(asArrayBuffer(raw));
  const nextUids = readDicomUids(asArrayBuffer(cleaned.bytes));
  assert.ok(rawUids && nextUids);
  assert.equal(nextUids.study, remapTeachingUid(rawUids.study));
  assert.equal(nextUids.series, remapTeachingUid(rawUids.series));
  assert.equal(nextUids.sop, remapTeachingUid(rawUids.sop));
  assert.equal(after.string("x00020003"), nextUids.sop);
  assert.equal(after.string("x00200052"), remapTeachingUid(before.string("x00200052")!));
  assert.notEqual(nextUids.study, rawUids.study);

  const again = deidentifyTeachingInstance(cleaned.bytes);
  assert.equal(evaluateDeid(inspectDicomBytes(asArrayBuffer(again.bytes))).pass, true);
  assert.deepEqual(pixelBytes(again.bytes), pixelBytes(raw));

  const gl = after.elements.x00020000;
  assert.ok(gl);
  const groupLength = after.uint32("x00020000");
  assert.equal(typeof groupLength, "number");
  const afterGroup = gl.dataOffset + gl.length + groupLength!;
  const nextGroup = cleaned.bytes[afterGroup]! | (cleaned.bytes[afterGroup + 1]! << 8);
  assert.notEqual(nextGroup, 0x0002);
});

test("non-identity values in emri_small.dcm are copied through", () => {
  const raw = new Uint8Array(readFileSync(RAW));
  const before = parseDicom(raw);
  const cleaned = deidentifyTeachingInstance(raw);
  const after = parseDicom(cleaned.bytes);
  for (const [tag, el] of Object.entries(before.elements)) {
    if (tag === "x00020000") continue;
    const hex = tag.slice(1).toUpperCase();
    if (TEACHING_STRIP_TAGS.has(hex)) {
      assert.equal(after.string(tag), undefined, tag);
      continue;
    }
    if (el.vr === "UI") {
      const old = before.string(tag);
      const neu = after.string(tag);
      if (!old) {
        assert.equal(neu, undefined, tag);
        continue;
      }
      const expected = old
        .split("\\")
        .map((part) => (part.startsWith("1.2.840.10008.") ? part : remapTeachingUid(part)))
        .join("\\");
      assert.equal(neu, expected, tag);
      continue;
    }
    const afterEl = after.elements[tag];
    assert.ok(afterEl, `missing ${tag}`);
    assert.equal(afterEl.length, el.length, tag);
    assert.deepEqual(
      cleaned.bytes.subarray(afterEl.dataOffset, afterEl.dataOffset + afterEl.length),
      raw.subarray(el.dataOffset, el.dataOffset + el.length),
      tag
    );
  }
});

test("two instances of one study stay coherent and drop nested identifiers", () => {
  const study = "1.2.826.0.1.3680043.2.100";
  const series = "1.2.826.0.1.3680043.2.200";
  const referenced = "1.2.826.0.1.3680043.2.300";
  const pixel = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2]);
  const a = syntheticExplicit({
    sop: "1.2.826.0.1.3680043.2.401",
    study,
    series,
    referenced,
    pixel,
    extra: undefSequence(
      "00081140",
      item(
        Buffer.concat([
          textElement("00081155", "UI", referenced),
          textElement("00100020", "LO", "NESTED-MRN"),
        ])
      )
    ),
  });
  const b = syntheticExplicit({
    sop: "1.2.826.0.1.3680043.2.402",
    study,
    series,
    referenced,
    pixel,
  });

  const da = deidentifyTeachingInstance(a);
  const db = deidentifyTeachingInstance(b);
  const ua = readDicomUids(asArrayBuffer(da.bytes));
  const ub = readDicomUids(asArrayBuffer(db.bytes));
  assert.ok(ua && ub);
  assert.equal(ua.study, ub.study);
  assert.equal(ua.series, ub.series);
  assert.equal(ua.study, remapTeachingUid(study));
  assert.notEqual(ua.sop, ub.sop);
  assert.equal(ua.sop, remapTeachingUid("1.2.826.0.1.3680043.2.401"));
  assert.equal(Buffer.from(da.bytes).includes(Buffer.from("DOE^JANE")), false);
  assert.equal(Buffer.from(da.bytes).includes(Buffer.from("NESTED-MRN")), false);
  assert.equal(Buffer.from(da.bytes).includes(Buffer.from("ACC-9988")), false);
  assert.equal(Buffer.from(da.bytes).includes(Buffer.from("PRIVATE-MRN")), false);
  assert.equal(Buffer.from(da.bytes).includes(pixel), true);
  const parsed = parseDicom(da.bytes);
  assert.equal(parsed.string("x00081030"), "Teaching series");
  assert.equal(parsed.string("x00100040"), "F");
  assert.equal(parsed.string("x00101010"), "054Y");
  assert.equal(evaluateDeid(inspectDicomBytes(asArrayBuffer(da.bytes))).pass, true);
  const ref = findUi(da.bytes, remapTeachingUid(referenced));
  assert.equal(ref, true);
});

test("implicit VR and deflated explicit VR are de-identified", () => {
  const implicit = syntheticImplicit();
  const cleaned = deidentifyTeachingInstance(implicit);
  const parsed = parseDicom(cleaned.bytes);
  assert.equal(parsed.string("x00100010"), undefined);
  assert.equal(parsed.string("x00020010"), "1.2.840.10008.1.2");
  assert.equal(parsed.string("x00080016"), "1.2.840.10008.5.1.4.1.1.4");
  assert.equal(parsed.string("x0020000d"), remapTeachingUid("1.2.826.0.1.3680043.9.3"));
  assert.equal(parsed.string("x00080018"), remapTeachingUid("1.2.826.0.1.3680043.9.1"));
  assert.deepEqual(pixelBytes(cleaned.bytes), Uint8Array.from([1, 2, 3, 4]));

  const dataset = Buffer.concat([
    textElement("00100010", "PN", "DEFLATE^NAME"),
    textElement("00080018", "UI", "1.2.826.0.1.3680043.9.8"),
    textElement("0020000d", "UI", "1.2.826.0.1.3680043.9.9"),
    textElement("0020000e", "UI", "1.2.826.0.1.3680043.9.10"),
    textElement("00080016", "UI", "1.2.840.10008.5.1.4.1.1.2"),
  ]);
  const wrapped = wrapPart10("1.2.840.10008.1.2.1.99", deflateRawSync(dataset), "1.2.826.0.1.3680043.9.8");
  const inflated = deidentifyTeachingInstance(wrapped);
  const back = parseDicom(inflated.bytes);
  assert.equal(back.string("x00020010"), "1.2.840.10008.1.2.1");
  assert.equal(back.string("x00100010"), undefined);
  assert.equal(back.string("x0020000d"), remapTeachingUid("1.2.826.0.1.3680043.9.9"));
  assert.equal(evaluateDeid(inspectDicomBytes(asArrayBuffer(inflated.bytes))).pass, true);
});

test("encapsulated pixel data is copied and a corrupt header fails closed", () => {
  const fragment = Buffer.from("PIXEL-FRAGMENT-MARKER-9f3a", "ascii");
  const file = wrapPart10(
    "1.2.840.10008.1.2.4.50",
    Buffer.concat([
      textElement("00080016", "UI", "1.2.840.10008.5.1.4.1.1.7"),
      textElement("00080018", "UI", "1.2.826.0.1.3680043.8.1"),
      textElement("0020000d", "UI", "1.2.826.0.1.3680043.8.2"),
      textElement("0020000e", "UI", "1.2.826.0.1.3680043.8.3"),
      textElement("00100010", "PN", "BURNED^NAME"),
      encapsulatedPixel(fragment),
    ]),
    "1.2.826.0.1.3680043.8.1"
  );
  const cleaned = deidentifyTeachingInstance(file);
  assert.equal(Buffer.from(cleaned.bytes).includes(fragment), true);
  assert.equal(Buffer.from(cleaned.bytes).includes(Buffer.from("BURNED^NAME")), false);
  assert.equal(parseDicom(cleaned.bytes).string("x00020010"), "1.2.840.10008.1.2.4.50");
  assert.equal(evaluateDeid(inspectDicomBytes(asArrayBuffer(cleaned.bytes))).pass, true);

  const junk = new Uint8Array(200);
  junk.set(new TextEncoder().encode("DICM"), 128);
  assert.throws(() => deidentifyTeachingInstance(junk), (e: unknown) => {
    assert.ok(e instanceof TeachingDeidError);
    assert.equal(e.userMessage, TEACHING_DEID_FAILURE);
    return true;
  });
});

test("every blocking identity keyword is removed from a synthetic file", () => {
  const chunks: Buffer[] = [
    textElement("00080016", "UI", "1.2.840.10008.5.1.4.1.1.2"),
    textElement("00080018", "UI", "1.2.826.0.1.3680043.7.1"),
    textElement("0020000d", "UI", "1.2.826.0.1.3680043.7.2"),
    textElement("0020000e", "UI", "1.2.826.0.1.3680043.7.3"),
    element("7FE00010", "OW", Buffer.from([0, 1])),
  ];
  for (const [keyword, hex] of Object.entries(BLOCKING_TAG_HEX)) {
    if (hex === "00101002") {
      chunks.push(element(hex, "SQ", item(textElement("00100020", "LO", `PHI-${keyword}`))));
    } else {
      chunks.push(textElement(hex, "LO", `PHI-${keyword}`));
    }
  }
  const cleaned = deidentifyTeachingInstance(
    wrapPart10("1.2.840.10008.1.2.1", Buffer.concat(chunks), "1.2.826.0.1.3680043.7.1")
  );
  const text = Buffer.from(cleaned.bytes).toString("latin1");
  for (const keyword of Object.keys(BLOCKING_TAG_HEX)) {
    assert.equal(text.includes(`PHI-${keyword}`), false, keyword);
  }
  assert.equal(evaluateDeid(inspectDicomBytes(asArrayBuffer(cleaned.bytes))).pass, true);
});

function findUi(bytes: Uint8Array, uid: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(uid));
}

function syntheticExplicit(opts: {
  sop: string;
  study: string;
  series: string;
  referenced: string;
  pixel: Buffer;
  extra?: Buffer;
}): Uint8Array {
  return wrapPart10(
    "1.2.840.10008.1.2.1",
    Buffer.concat([
      textElement("00080016", "UI", "1.2.840.10008.5.1.4.1.1.4"),
      textElement("00080018", "UI", opts.sop),
      textElement("0020000d", "UI", opts.study),
      textElement("0020000e", "UI", opts.series),
      textElement("00080050", "SH", "ACC-9988"),
      textElement("00100010", "PN", "DOE^JANE"),
      textElement("00100020", "LO", "MRN-4412"),
      textElement("00100030", "DA", "19800102"),
      textElement("00100040", "CS", "F"),
      textElement("00101010", "AS", "054Y"),
      textElement("00081030", "LO", "Teaching series"),
      textElement("00080080", "LO", "City Hospital"),
      element("00090010", "LO", Buffer.from("PRIVATE-MRN ", "ascii")),
      opts.extra ?? Buffer.alloc(0),
      element("7FE00010", "OW", opts.pixel),
    ]),
    opts.sop
  );
}

function syntheticImplicit(): Uint8Array {
  const dataset = Buffer.concat([
    implicitElement("00080016", Buffer.from(padUi("1.2.840.10008.5.1.4.1.1.4"), "ascii")),
    implicitElement("00080018", Buffer.from(padUi("1.2.826.0.1.3680043.9.1"), "ascii")),
    implicitElement("00100010", Buffer.from("SMITH^JANE", "ascii")),
    implicitElement("0020000d", Buffer.from(padUi("1.2.826.0.1.3680043.9.3"), "ascii")),
    implicitElement("0020000e", Buffer.from(padUi("1.2.826.0.1.3680043.9.2"), "ascii")),
    implicitElement("7FE00010", Buffer.from([1, 2, 3, 4])),
  ]);
  return wrapPart10("1.2.840.10008.1.2", dataset, "1.2.826.0.1.3680043.9.1");
}

function wrapPart10(ts: string, dataset: Buffer, mediaSop: string): Uint8Array {
  const metaBody = Buffer.concat([
    element("00020001", "OB", Buffer.from([0x00, 0x01])),
    textElement("00020002", "UI", "1.2.840.10008.5.1.4.1.1.4"),
    textElement("00020003", "UI", mediaSop),
    textElement("00020010", "UI", ts),
    textElement("00020012", "UI", "1.2.826.0.1.3680043.10.1"),
  ]);
  const gl = element("00020000", "UL", u32(metaBody.length));
  return new Uint8Array(
    Buffer.concat([Buffer.alloc(128), Buffer.from("DICM"), gl, metaBody, dataset])
  );
}

const LONG_VR = new Set(["OB", "OW", "OF", "SQ", "UT", "UN", "OD", "OL", "UC", "UR", "UV", "SV"]);

function textElement(tag: string, vr: string, value: string): Buffer {
  const padded = vr === "UI" ? padUi(value) : value.length % 2 === 0 ? value : `${value} `;
  return element(tag, vr, Buffer.from(padded, "latin1"));
}

function padUi(uid: string): string {
  return uid.length % 2 === 0 ? uid : `${uid}\0`;
}

function element(tag: string, vr: string, value: Buffer): Buffer {
  const long = LONG_VR.has(vr);
  const header = Buffer.alloc(long ? 12 : 8);
  header.writeUInt16LE(Number.parseInt(tag.slice(0, 4), 16), 0);
  header.writeUInt16LE(Number.parseInt(tag.slice(4), 16), 2);
  header.write(vr, 4, "ascii");
  if (long) {
    header.writeUInt16LE(0, 6);
    header.writeUInt32LE(value.length, 8);
  } else {
    header.writeUInt16LE(value.length, 6);
  }
  return Buffer.concat([header, value]);
}

function implicitElement(tag: string, value: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(Number.parseInt(tag.slice(0, 4), 16), 0);
  header.writeUInt16LE(Number.parseInt(tag.slice(4), 16), 2);
  header.writeUInt32LE(value.length, 4);
  return Buffer.concat([header, value]);
}

function item(content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0xfffe, 0);
  header.writeUInt16LE(0xe000, 2);
  header.writeUInt32LE(content.length, 4);
  return Buffer.concat([header, content]);
}

function undefSequence(tag: string, itemBytes: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16LE(Number.parseInt(tag.slice(0, 4), 16), 0);
  header.writeUInt16LE(Number.parseInt(tag.slice(4), 16), 2);
  header.write("SQ", 4, "ascii");
  header.writeUInt16LE(0, 6);
  header.writeUInt32LE(0xffffffff, 8);
  const delim = Buffer.alloc(8);
  delim.writeUInt16LE(0xfffe, 0);
  delim.writeUInt16LE(0xe0dd, 2);
  return Buffer.concat([header, itemBytes, delim]);
}

function encapsulatedPixel(fragment: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16LE(0x7fe0, 0);
  header.writeUInt16LE(0x0010, 2);
  header.write("OB", 4, "ascii");
  header.writeUInt16LE(0, 6);
  header.writeUInt32LE(0xffffffff, 8);
  const delim = Buffer.alloc(8);
  delim.writeUInt16LE(0xfffe, 0);
  delim.writeUInt16LE(0xe0dd, 2);
  return Buffer.concat([header, item(Buffer.alloc(0)), item(fragment), delim]);
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
}
