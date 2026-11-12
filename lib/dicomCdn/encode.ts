// ============================================================================
// lib/dicomCdn/encode.ts  (server only)
//
// The two encoders, both already shipped with Cornerstone's codecs — no new
// native dependency on Cloud Run:
//
//   HTJ2K  @cornerstonejs/codec-openjph       lossless, RPCL progression, TLM
//          markers, 5 decompositions. Resolution-progressive: a prefix of the
//          codestream decodes to a lower-resolution image, which Cornerstone's
//          HTJ2K streaming path can use later. Measured ~12 ms for a 512² slice.
//   JPEG   @cornerstonejs/codec-libjpeg-turbo-8bit, 8-bit grey previews.
//
// The WASM modules are instantiated once per process. Both packages are
// external to the Next server bundle (next.config.mjs) so emscripten can find
// its .wasm next to its glue.
// ============================================================================

import { PREVIEW_JPEG_QUALITY } from "./format";

interface EmscriptenEncoder {
  getDecodedBuffer(info: Record<string, unknown>): Uint8Array;
  getEncodedBuffer(): Uint8Array;
  encode(): void;
  delete(): void;
}

interface HtJ2kEncoder extends EmscriptenEncoder {
  setQuality(lossless: boolean, quantizationStep: number): void;
  setProgressionOrder(order: number): void;
  setTLMMarker(on: boolean): void;
  setDecompositions(n: number): void;
  setBlockDimensions?(dims: { width: number; height: number }): void;
}

interface JpegEncoder extends EmscriptenEncoder {
  setQuality(quality: number): void;
  setProgressive?(on: boolean): void;
}

interface OpenJphModule {
  HTJ2KEncoder: new () => HtJ2kEncoder;
}

interface TurboModule {
  JPEGEncoder: new () => JpegEncoder;
}

/** OpenJPH progression orders: 0 LRCP, 1 RLCP, 2 RPCL, 3 PCRL, 4 CPRL. */
const PROGRESSION_RPCL = 2;

// Node's own `require`, fetched through a direct eval so webpack neither
// bundles the emscripten glue (it locates its .wasm via __dirname) nor warns
// about a dynamic require. In the Next server chunk this is the chunk's CJS
// require (resolves /app/node_modules); under tsx it is the module's. The
// standalone trace ships both packages (next.config.mjs
// `outputFileTracingIncludes`).
// eslint-disable-next-line no-eval
const nodeRequire = eval("require") as NodeRequire;

let openjph: Promise<OpenJphModule> | null = null;
let turbo: Promise<TurboModule> | null = null;

function loadOpenJph(): Promise<OpenJphModule> {
  if (!openjph) {
    const factory = nodeRequire("@cornerstonejs/codec-openjph") as () => Promise<OpenJphModule>;
    openjph = factory();
  }
  return openjph;
}

function loadTurbo(): Promise<TurboModule> {
  if (!turbo) {
    const factory = nodeRequire("@cornerstonejs/codec-libjpeg-turbo-8bit/wasmjs") as () => Promise<TurboModule>;
    turbo = factory();
  }
  return turbo;
}

/** Quiet OpenJPH's "ojph info" lines around a call. */
async function quietly<T>(fn: () => T): Promise<T> {
  const log = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("ojph info")) return;
    log(...args);
  };
  try {
    return fn();
  } finally {
    console.log = log;
  }
}

export interface GreyFrame {
  /** Raw little-endian pixel bytes, rows*columns*(bitsAllocated/8). */
  bytes: Uint8Array;
  rows: number;
  columns: number;
  bitsAllocated: 8 | 16;
  signed: boolean;
}

/** Lossless HTJ2K (RPCL) codestream for one grey frame. */
export async function encodeHtj2kLossless(frame: GreyFrame): Promise<Uint8Array> {
  const mod = await loadOpenJph();
  return quietly(() => {
    const encoder = new mod.HTJ2KEncoder();
    try {
      const input = encoder.getDecodedBuffer({
        width: frame.columns,
        height: frame.rows,
        bitsPerSample: frame.bitsAllocated,
        componentCount: 1,
        isSigned: frame.signed,
        isUsingColorTransform: false,
      });
      const need = frame.rows * frame.columns * (frame.bitsAllocated / 8);
      if (frame.bytes.byteLength < need) throw new Error("Frame is shorter than its geometry");
      input.set(frame.bytes.subarray(0, need));
      encoder.setQuality(true, 0);
      encoder.setProgressionOrder(PROGRESSION_RPCL);
      encoder.setTLMMarker(true);
      encoder.setDecompositions(5);
      encoder.encode();
      // Copy out of the WASM heap before the encoder is freed.
      return encoder.getEncodedBuffer().slice();
    } finally {
      encoder.delete();
    }
  });
}

/** Baseline 8-bit grey JPEG. */
export async function encodeGreyJpeg(
  grey: Uint8Array,
  width: number,
  height: number,
  quality = PREVIEW_JPEG_QUALITY
): Promise<Uint8Array> {
  const mod = await loadTurbo();
  const encoder = new mod.JPEGEncoder();
  try {
    const input = encoder.getDecodedBuffer({
      width,
      height,
      bitsPerSample: 8,
      componentCount: 1,
      isSigned: false,
    });
    input.set(grey.subarray(0, width * height));
    encoder.setQuality(quality);
    encoder.encode();
    return encoder.getEncodedBuffer().slice();
  } finally {
    encoder.delete();
  }
}
