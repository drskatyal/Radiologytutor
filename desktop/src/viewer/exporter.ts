// Export what is on screen: a still (PNG / JPEG), a series as an image
// sequence, or a cine as video (MP4 via WebCodecs, else Motion-JPEG AVI).
//
// Anonymous by default. The pixels come from the viewport canvas, which never
// holds patient text (Cornerstone draws only pixels there); the corner overlay
// is redrawn here from what the user chose: nothing, an anonymous line
// (modality · series · image · W/L) or — explicitly — the full overlay.
// Burned-in annotations inside the pixel data are a separate risk that no
// header scrub can remove; the dialog says so.

export type OverlayMode = "none" | "anonymous" | "full";

export interface FrameText {
  /** Anonymous facts: always safe to print. */
  anonymous: string[];
  /** Identifying lines (patient, IDs, dates, institution). */
  identifying: string[];
}

export interface CaptureOptions {
  overlay: OverlayMode;
  annotations: boolean;
  text: FrameText;
  /** Output scale relative to the on-screen CSS size. */
  scale?: number;
}

async function svgLayerImage(element: HTMLElement): Promise<HTMLImageElement | null> {
  const svg = element.querySelector("svg");
  if (!svg || !svg.childElementCount) return null;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const { width, height } = element.getBoundingClientRect();
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const markup = new XMLSerializer().serializeToString(clone);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  const img = new Image();
  img.decoding = "sync";
  await new Promise<void>((resolve) => {
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
  });
  return img.naturalWidth ? img : null;
}

/** Composite pixels + (optional) annotations + (optional) text into a new canvas. */
export async function captureViewport(element: HTMLElement, options: CaptureOptions): Promise<HTMLCanvasElement> {
  const source = element.querySelector("canvas");
  if (!source) throw new Error("Nothing is rendered in this viewport yet.");
  const { width, height } = element.getBoundingClientRect();
  const scale = options.scale ?? Math.max(1, window.devicePixelRatio || 1);
  const out = document.createElement("canvas");
  out.width = Math.round(width * scale);
  out.height = Math.round(height * scale);
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, 0, 0, out.width, out.height);
  if (options.annotations) {
    const svg = await svgLayerImage(element);
    if (svg) ctx.drawImage(svg, 0, 0, out.width, out.height);
  }
  if (options.overlay !== "none") {
    const lines = options.overlay === "full" ? [...options.text.identifying, ...options.text.anonymous] : options.text.anonymous;
    const size = Math.round(12 * scale);
    ctx.font = `${size}px Inter, -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 3 * scale;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    lines.forEach((line, i) => ctx.fillText(line, 8 * scale, 8 * scale + i * size * 1.35));
  }
  return out;
}

export async function canvasBytes(canvas: HTMLCanvasElement, format: "png" | "jpeg", quality = 0.92): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, format === "png" ? "image/png" : "image/jpeg", quality)
  );
  if (!blob) throw new Error("The image could not be encoded.");
  return new Uint8Array(await blob.arrayBuffer());
}

export const H264_CODEC = "avc1.640028";

/**
 * What this WebView can encode, best first. `VideoEncoder` existing is not
 * enough: WebKitGTK ships the API without an H.264 encoder, so ask the
 * encoder itself.
 */
export async function videoSupport(): Promise<{ mp4: boolean }> {
  const VE = (window as unknown as {
    VideoEncoder?: { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> };
  }).VideoEncoder;
  let mp4 = false;
  try {
    mp4 = !!(await VE?.isConfigSupported?.({ codec: H264_CODEC, width: 1280, height: 720, bitrate: 8_000_000, framerate: 30 }))
      ?.supported;
  } catch {
    mp4 = false;
  }
  return { mp4 };
}

export interface VideoSource {
  count: number;
  /** Show frame i and resolve once it has rendered. */
  showFrame: (i: number) => Promise<void>;
  capture: (i: number) => Promise<HTMLCanvasElement>;
}

/** Encode every frame to H.264 MP4 (WebCodecs). Faster than real time. */
export async function encodeMp4(
  src: VideoSource,
  fps: number,
  onProgress: (done: number) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
  await src.showFrame(0);
  const first = await src.capture(0);
  // H.264 needs even dimensions.
  const width = first.width - (first.width % 2);
  const height = first.height - (first.height % 2);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height, frameRate: fps },
    fastStart: "in-memory",
  });
  type Encoder = {
    configure(c: unknown): void;
    encode(frame: unknown, o?: unknown): void;
    flush(): Promise<void>;
    close(): void;
  };
  const W = window as unknown as {
    VideoEncoder: new (init: { output: (chunk: unknown, meta: unknown) => void; error: (e: unknown) => void }) => Encoder;
    VideoFrame: new (src: CanvasImageSource, init: { timestamp: number; duration: number }) => { close(): void };
  };
  let failure: unknown = null;
  const encoder = new W.VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk as never, meta as never),
    error: (e) => (failure = e),
  });
  encoder.configure({ codec: H264_CODEC, width, height, bitrate: 8_000_000, framerate: fps });
  const frameUs = Math.round(1_000_000 / fps);
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const sctx = scratch.getContext("2d")!;
  for (let i = 0; i < src.count; i += 1) {
    if (signal?.aborted) throw new Error("cancelled");
    if (failure) throw failure;
    if (i > 0) await src.showFrame(i);
    const canvas = i === 0 ? first : await src.capture(i);
    sctx.drawImage(canvas, 0, 0, width, height);
    const frame = new W.VideoFrame(scratch, { timestamp: i * frameUs, duration: frameUs });
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    onProgress(i + 1);
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  muxer.finalize();
  return new Uint8Array((muxer.target as InstanceType<typeof ArrayBufferTarget>).buffer);
}

/**
 * Motion-JPEG AVI: no codec dependency at all, faster than real time, and it
 * plays in VLC, Windows Media Player and QuickTime. The fallback when the
 * WebView has no H.264 encoder (WebKitGTK without GStreamer's x264).
 */
export async function encodeMjpegAvi(
  src: VideoSource,
  fps: number,
  onProgress: (done: number) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const frames: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  for (let i = 0; i < src.count; i += 1) {
    if (signal?.aborted) throw new Error("cancelled");
    await src.showFrame(i);
    const canvas = await src.capture(i);
    width = canvas.width;
    height = canvas.height;
    frames.push(await canvasBytes(canvas, "jpeg", 0.9));
    onProgress(i + 1);
  }
  return buildMjpegAvi(frames, width, height, fps);
}

/** RIFF AVI 1.0 container around JPEG frames (pure; unit-tested). */
export function buildMjpegAvi(frames: readonly Uint8Array[], width: number, height: number, fps: number): Uint8Array {
  const pad = (n: number) => n + (n & 1);
  const moviData = frames.reduce((n, f) => n + 8 + pad(f.byteLength), 0);
  const hdrlSize = 4 + (8 + 56) + (8 + 4 + (8 + 56) + (8 + 40));
  const idxSize = frames.length * 16;
  const total = 4 + (8 + hdrlSize) + (8 + 4 + moviData) + (8 + idxSize);
  const buf = new Uint8Array(8 + total);
  const dv = new DataView(buf.buffer);
  let o = 0;
  const fourcc = (s: string) => {
    for (let k = 0; k < 4; k += 1) buf[o + k] = s.charCodeAt(k);
    o += 4;
  };
  const u32 = (v: number) => {
    dv.setUint32(o, v >>> 0, true);
    o += 4;
  };
  const u16 = (v: number) => {
    dv.setUint16(o, v, true);
    o += 2;
  };
  const maxFrame = frames.reduce((m, f) => Math.max(m, f.byteLength), 0);

  fourcc("RIFF"); u32(total); fourcc("AVI ");
  fourcc("LIST"); u32(hdrlSize); fourcc("hdrl");
  fourcc("avih"); u32(56);
  u32(Math.round(1_000_000 / fps)); u32(maxFrame * fps); u32(0); u32(0x10); // AVIF_HASINDEX
  u32(frames.length); u32(0); u32(1); u32(maxFrame); u32(width); u32(height);
  u32(0); u32(0); u32(0); u32(0);
  fourcc("LIST"); u32(4 + (8 + 56) + (8 + 40)); fourcc("strl");
  fourcc("strh"); u32(56);
  fourcc("vids"); fourcc("MJPG"); u32(0); u16(0); u16(0); u32(0);
  u32(1); u32(fps); u32(0); u32(frames.length); u32(maxFrame); u32(0xffffffff); u32(0);
  u16(0); u16(0); u16(width); u16(height);
  fourcc("strf"); u32(40);
  u32(40); u32(width); u32(height); u16(1); u16(24); fourcc("MJPG"); u32(width * height * 3);
  u32(0); u32(0); u32(0); u32(0);
  fourcc("LIST"); u32(4 + moviData); const moviStart = o; fourcc("movi");
  const offsets: number[] = [];
  for (const f of frames) {
    offsets.push(o - moviStart);
    fourcc("00dc"); u32(f.byteLength);
    buf.set(f, o);
    o += pad(f.byteLength);
  }
  fourcc("idx1"); u32(idxSize);
  frames.forEach((f, k) => {
    fourcc("00dc"); u32(0x10); u32(offsets[k]); u32(f.byteLength);
  });
  return buf;
}

/**
 * A file name that carries no patient identifiers: modality, series number and
 * a timestamp. Series descriptions are free text and are left out on purpose.
 */
export function exportBaseName(parts: { modality?: string; seriesNumber?: number }, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return [parts.modality || "image", parts.seriesNumber != null ? `se${parts.seriesNumber}` : "", stamp].filter(Boolean).join("_");
}
