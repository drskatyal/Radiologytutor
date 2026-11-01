import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import AdmZip from "adm-zip";
import {
  ZIP_METHOD_DEFLATED,
  ZIP_METHOD_STORED,
  hasZipMagic,
  isZipNoise,
  looksLikeZipName,
  readZipDirectory,
  zipEntryDataOffset,
  type ZipRead,
} from "../packages/viewer-core/src/zipArchive";

// The browser adapter (Blob.slice + DecompressionStream) is a thin layer; the
// part that can be wrong — finding the directory, ZIP64, local-header offsets
// — is pure over a read callback and pinned here against real archives.

const reader = (bytes: Uint8Array): ZipRead => async (start, end) => bytes.subarray(start, end);

function dicomLike(n: number, size = 4096): Buffer {
  const b = Buffer.alloc(size, n & 0xff);
  b.write("DICM", 128, "latin1");
  return b;
}

test("lists entries of a real (adm-zip) archive and finds each entry's data", async () => {
  const zip = new AdmZip();
  zip.addFile("STUDY/SE1/IM000001", dicomLike(1));
  zip.addFile("STUDY/SE1/IM000002", dicomLike(2));
  zip.addFile("STUDY/DICOMDIR", Buffer.from("index"));
  const bytes = new Uint8Array(zip.toBuffer());
  assert.ok(hasZipMagic(bytes));

  const entries = await readZipDirectory(reader(bytes), bytes.length);
  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    ["STUDY/DICOMDIR", "STUDY/SE1/IM000001", "STUDY/SE1/IM000002"]
  );
  for (const entry of entries) {
    const start = await zipEntryDataOffset(reader(bytes), entry);
    const data = bytes.subarray(start, start + entry.compressedSize);
    const body =
      entry.method === ZIP_METHOD_STORED
        ? Buffer.from(data)
        : (await import("node:zlib")).inflateRawSync(Buffer.from(data));
    assert.equal(body.length, entry.uncompressedSize);
    if (entry.name.endsWith("IM000002")) assert.equal(body.toString("latin1", 128, 132), "DICM");
  }
});

/** Hand-built archive: one STORED, one DEFLATED entry, an archive comment, optional ZIP64. */
function buildZip(opts: { zip64?: boolean; comment?: string } = {}): { bytes: Uint8Array; payloads: Buffer[] } {
  const payloads = [dicomLike(7, 2000), dicomLike(9, 3000)];
  const methods = [ZIP_METHOD_STORED, ZIP_METHOD_DEFLATED];
  const names = ["a/IM1", "a/IM2"];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  payloads.forEach((payload, i) => {
    const data = methods[i] === ZIP_METHOD_STORED ? payload : deflateRawSync(payload);
    const name = Buffer.from(names[i]);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(methods[i], 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    // A local extra field the central directory does not have: the data
    // offset must come from the LOCAL header.
    const localExtra = Buffer.alloc(8);
    localExtra.writeUInt16LE(0xcafe, 0);
    localExtra.writeUInt16LE(4, 2);
    local.writeUInt16LE(localExtra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(methods[i], 10);
    let extra = Buffer.alloc(0);
    if (opts.zip64) {
      central.writeUInt32LE(0xffffffff, 20);
      central.writeUInt32LE(0xffffffff, 24);
      central.writeUInt32LE(0xffffffff, 42);
      extra = Buffer.alloc(4 + 24);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(payload.length), 4);
      extra.writeBigUInt64LE(BigInt(data.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    } else {
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(payload.length, 24);
      central.writeUInt32LE(offset, 42);
    }
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    const chunk = Buffer.concat([local, name, localExtra, data]);
    locals.push(chunk);
    centrals.push(Buffer.concat([central, name, extra]));
    offset += chunk.length;
  });
  const cd = Buffer.concat(centrals);
  const cdOffset = offset;
  const comment = Buffer.from(opts.comment ?? "");
  const parts: Buffer[] = [...locals, cd];
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  if (opts.zip64) {
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(BigInt(payloads.length), 24);
    z64.writeBigUInt64LE(BigInt(payloads.length), 32);
    z64.writeBigUInt64LE(BigInt(cd.length), 40);
    z64.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(cdOffset + cd.length), 8);
    parts.push(z64, locator);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
  } else {
    eocd.writeUInt16LE(payloads.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
  }
  eocd.writeUInt16LE(comment.length, 20);
  parts.push(eocd, comment);
  return { bytes: new Uint8Array(Buffer.concat(parts)), payloads };
}

for (const zip64 of [false, true]) {
  test(`reads stored + deflated entries${zip64 ? " (ZIP64)" : ""} behind an archive comment`, async () => {
    const { bytes, payloads } = buildZip({ zip64, comment: "exported by PACS" });
    const entries = await readZipDirectory(reader(bytes), bytes.length);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.method), [ZIP_METHOD_STORED, ZIP_METHOD_DEFLATED]);
    const { inflateRawSync } = await import("node:zlib");
    for (const [i, entry] of entries.entries()) {
      assert.equal(entry.uncompressedSize, payloads[i].length);
      const start = await zipEntryDataOffset(reader(bytes), entry);
      const raw = Buffer.from(bytes.subarray(start, start + entry.compressedSize));
      const body = entry.method === ZIP_METHOD_STORED ? raw : inflateRawSync(raw);
      assert.ok(body.equals(payloads[i]), `entry ${entry.name} round-trips`);
    }
  });
}

test("rejects non-ZIP input with a readable error", async () => {
  const junk = new Uint8Array(1000).fill(7);
  await assert.rejects(readZipDirectory(reader(junk), junk.length), /Not a ZIP archive/);
  await assert.rejects(readZipDirectory(reader(junk.subarray(0, 10)), 10), /too short/);
});

test("names: .zip detection and archive noise", () => {
  assert.ok(looksLikeZipName("Study.ZIP"));
  assert.ok(!looksLikeZipName("IM000001"));
  assert.ok(isZipNoise("DICOM/"));
  assert.ok(isZipNoise("__MACOSX/DICOM/._IM1"));
  assert.ok(isZipNoise("export/__MACOSX/x"));
  assert.ok(!isZipNoise("DICOM/ST0/SE1/IM1"));
});
