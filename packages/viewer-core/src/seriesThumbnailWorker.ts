// Thumbnail worker: window + box-filter + JPEG encode, off the main thread.
//
// Receives a small sampled grid (seriesThumbnail.ts sampleForThumb), returns a
// JPEG Blob when the worker has OffscreenCanvas, else the RGBA pixels for the
// page to encode. Never logs: nothing that crosses here may reach a console.

import { renderThumbRgba, type ThumbSample, type ThumbWindow } from "./seriesThumbnail";

export interface ThumbJob {
  id: number;
  sample: ThumbSample;
  window: ThumbWindow;
  invert: boolean;
  edge: number;
}

export type ThumbJobResult =
  | { id: number; blob: Blob }
  | { id: number; rgba: Uint8ClampedArray; width: number; height: number }
  | { id: number; failed: true };

interface WorkerScope {
  onmessage: ((event: MessageEvent<ThumbJob>) => void) | null;
  postMessage(message: ThumbJobResult, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = async (event) => {
  const { id, sample, window: win, invert, edge } = event.data;
  try {
    const out = renderThumbRgba(sample, win, invert, edge);
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(out.width, out.height);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.putImageData(new ImageData(out.rgba as Uint8ClampedArray<ArrayBuffer>, out.width, out.height), 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
        scope.postMessage({ id, blob });
        return;
      }
    }
    scope.postMessage({ id, rgba: out.rgba, width: out.width, height: out.height }, [out.rgba.buffer]);
  } catch {
    scope.postMessage({ id, failed: true });
  }
};
