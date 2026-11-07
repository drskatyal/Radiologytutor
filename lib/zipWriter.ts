// Streaming ZIP writer (STORED entries, no compression: DICOM pixel data is
// usually compressed already). Each entry is written as soon as its bytes are
// known, so a study download never sits in memory as a whole.
// Classic ZIP (no ZIP64): up to 65,535 entries and 4 GiB total.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const ZIP_MAX_BYTES = 0xffffffff - 1024 * 1024;

interface CentralEntry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

export class ZipWriter {
  private offset = 0;
  private entries: CentralEntry[] = [];

  /** Local header + data for one file. Returns the bytes to emit. */
  file(name: string, data: Uint8Array): Uint8Array[] {
    if (this.entries.length >= 0xffff) throw new Error("Too many files for one ZIP");
    if (this.offset + data.length + 1024 > ZIP_MAX_BYTES) throw new Error("ZIP would exceed 4 GiB");
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const header = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true); // version needed
    v.setUint16(6, 0x0800, true); // UTF-8 names
    v.setUint16(8, 0, true); // stored
    v.setUint16(10, 0, true); // time
    v.setUint16(12, 0x21, true); // date 1980-01-01
    v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);
    header.set(nameBytes, 30);
    this.entries.push({ name: nameBytes, crc, size: data.length, offset: this.offset });
    this.offset += header.length + data.length;
    return [header, data];
  }

  /** Central directory + end record. */
  finish(): Uint8Array {
    const parts: Uint8Array[] = [];
    let size = 0;
    for (const e of this.entries) {
      const rec = new Uint8Array(46 + e.name.length);
      const v = new DataView(rec.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, 0, true);
      v.setUint16(14, 0x21, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint32(42, e.offset, true);
      rec.set(e.name, 46);
      parts.push(rec);
      size += rec.length;
    }
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, this.entries.length, true);
    v.setUint16(10, this.entries.length, true);
    v.setUint32(12, size, true);
    v.setUint32(16, this.offset, true);
    parts.push(end);
    const out = new Uint8Array(size + 22);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}
