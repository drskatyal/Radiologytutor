// A tiny, synthetic DICOM Part 10 file, built in memory.
//
// The free viewer's idle prewarm renders one of these through EXACTLY the path
// a dropped study takes (File → wadouri file loader → NATURALIZED metadata →
// rescale → float texture → shaders), so every first-image cost that is paid
// once per page — GL extensions, texture formats, shader programs — is paid
// on the dropzone instead of between "files dropped" and the first pixel.
//
// Nothing here is a real patient: fixed synthetic UIDs, no names, a gradient.
// It never leaves the page. Explicit VR Little Endian, the simplest syntax.

export interface SyntheticDicomOptions {
  /** Signed with a rescale (CT-like) or unsigned without (MR-like). */
  kind: "ct" | "mr";
  /** Side in pixels (square). Default 16. */
  side?: number;
}

const SYNTHETIC_ROOT = "1.2.826.0.1.3680043.10.1078.99";

function pad(value: string, padChar: string): string {
  return value.length % 2 === 0 ? value : value + padChar;
}

/** One explicit-VR little-endian element. */
function element(group: number, elem: number, vr: string, value: Uint8Array): Uint8Array {
  const longForm = vr === "OB" || vr === "OW" || vr === "UN" || vr === "SQ" || vr === "UT";
  const header = new Uint8Array(longForm ? 12 : 8);
  const view = new DataView(header.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, elem, true);
  header[4] = vr.charCodeAt(0);
  header[5] = vr.charCodeAt(1);
  if (longForm) view.setUint32(8, value.length, true);
  else view.setUint16(6, value.length, true);
  const out = new Uint8Array(header.length + value.length);
  out.set(header);
  out.set(value, header.length);
  return out;
}

const text = (value: string, vr = "UI") => {
  const padded = pad(value, vr === "UI" ? "\0" : " ");
  return new TextEncoder().encode(padded);
};
const us = (value: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value, true);
  return b;
};
const ul = (value: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value, true);
  return b;
};

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Bytes of a valid Part 10 file: preamble, DICM, file meta, a 16-bit image. */
export function syntheticDicomBytes({ kind, side = 16 }: SyntheticDicomOptions): Uint8Array {
  const signed = kind === "ct";
  const sopClass = signed ? "1.2.840.10008.5.1.4.1.1.2" : "1.2.840.10008.5.1.4.1.1.4";
  const sop = `${SYNTHETIC_ROOT}.${signed ? 1 : 2}`;
  const metaBody = concat([
    element(0x0002, 0x0001, "OB", new Uint8Array([0, 1])),
    element(0x0002, 0x0002, "UI", text(sopClass)),
    element(0x0002, 0x0003, "UI", text(sop)),
    element(0x0002, 0x0010, "UI", text("1.2.840.10008.1.2.1")),
    element(0x0002, 0x0012, "UI", text(`${SYNTHETIC_ROOT}.0`)),
  ]);
  const meta = concat([element(0x0002, 0x0000, "UL", ul(metaBody.length)), metaBody]);

  const pixels = signed ? new Int16Array(side * side) : new Uint16Array(side * side);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i % side) * 64 + (signed ? -512 : 0);
  const pixelBytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);

  // Tags in ascending order, as Part 10 requires.
  const dataset = concat([
    element(0x0008, 0x0016, "UI", text(sopClass)),
    element(0x0008, 0x0018, "UI", text(sop)),
    element(0x0008, 0x0060, "CS", text(signed ? "CT" : "MR", "CS")),
    element(0x0020, 0x000d, "UI", text(`${SYNTHETIC_ROOT}.10`)),
    element(0x0020, 0x000e, "UI", text(`${SYNTHETIC_ROOT}.${signed ? 11 : 12}`)),
    element(0x0020, 0x0013, "IS", text("1", "IS")),
    element(0x0020, 0x0032, "DS", text("0\\0\\0", "DS")),
    element(0x0020, 0x0037, "DS", text("1\\0\\0\\0\\1\\0", "DS")),
    element(0x0020, 0x0052, "UI", text(`${SYNTHETIC_ROOT}.13`)),
    element(0x0028, 0x0002, "US", us(1)),
    element(0x0028, 0x0004, "CS", text("MONOCHROME2", "CS")),
    element(0x0028, 0x0010, "US", us(side)),
    element(0x0028, 0x0011, "US", us(side)),
    element(0x0028, 0x0030, "DS", text("1\\1", "DS")),
    element(0x0028, 0x0100, "US", us(16)),
    element(0x0028, 0x0101, "US", us(signed ? 16 : 12)),
    element(0x0028, 0x0102, "US", us(signed ? 15 : 11)),
    element(0x0028, 0x0103, "US", us(signed ? 1 : 0)),
    element(0x0028, 0x1050, "DS", text(signed ? "40" : "500", "DS")),
    element(0x0028, 0x1051, "DS", text(signed ? "400" : "1000", "DS")),
    ...(signed
      ? [element(0x0028, 0x1052, "DS", text("-1024", "DS")), element(0x0028, 0x1053, "DS", text("1", "DS"))]
      : []),
    element(0x7fe0, 0x0010, "OW", pixelBytes),
  ]);

  const preamble = new Uint8Array(132);
  preamble.set(new TextEncoder().encode("DICM"), 128);
  return concat([preamble, meta, dataset]);
}
