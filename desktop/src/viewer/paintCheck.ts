// Is there actually an image on screen?
//
// Cornerstone can resolve `setStack` and "render" while the canvas stays black:
// a GPU path whose 16-bit texture upload the driver silently drops (seen on a
// Windows laptop with Intel graphics: thumbnails fine, main viewport black).
// After the first render of a series we sample the on-screen canvas. If it is
// blank while the image has real contrast inside the current window, switch
// Cornerstone to CPU rendering for the session and draw again. The result goes
// into the benchmark report, and CI asserts it (`viewport.nonBlank`).

import type { Engine } from "./engine";

export interface PaintHealth {
  /** Brightest sampled channel value (0–255) on the on-screen canvas. */
  maxLum: number;
  nonBlank: boolean;
  /** Was the image expected to show anything at all (contrast inside the window)? */
  expectVisible: boolean;
  renderPath: "gpu" | "cpu" | "cpu-fallback";
}

/** Session-wide: the last check, for the bench report. */
export const paintHealth: { last?: PaintHealth; fellBack: boolean; fallbackWhy?: Record<string, unknown> } = {
  fellBack: false,
};

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
/** rAF stops in a hidden or locked window; never wait on it forever. */
const nextFrame = () => Promise.race([frame(), new Promise<void>((r) => setTimeout(r, 250))]);

/** Test hook (FLOWRAD_SIMULATE_BLANK_GPU=1): the GPU path reads as black, so the CPU fallback and its timing can be tested on any machine. */
let simulateBlank: Promise<boolean> | null = null;
function simulatingBlankGpu(): Promise<boolean> {
  simulateBlank ??= import("../platform")
    .then(({ invoke, isTauri }) => (isTauri ? invoke<boolean>("simulate_blank_gpu") : false))
    .catch(() => false);
  return simulateBlank;
}

export function sampleCanvas(element: HTMLElement | null): number | null {
  const canvas = element?.querySelector("canvas");
  if (!canvas || !canvas.width || !canvas.height) return null;
  const probe = document.createElement("canvas");
  probe.width = probe.height = 64;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, 64, 64);
  const data = ctx.getImageData(0, 0, 64, 64).data;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i], data[i + 1], data[i + 2]);
  return max;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function expectVisible(engine: Engine, vp: any, imageId: string | undefined): boolean {
  const image = imageId ? (engine.core.cache.getImage(imageId) as { minPixelValue?: number; maxPixelValue?: number } | undefined) : undefined;
  // Not decoded yet: a blank canvas is expected, not a GPU failure. (This was
  // `true`: on a cold open the check ran before the first slice decoded and
  // switched the whole session to CPU rendering, which MPR / 3D cannot use;
  // HP: MPR on an uncached study never drew, an MRI drew on the CPU path.)
  if (!image) return false;
  if (image.minPixelValue == null || image.maxPixelValue == null) return true;
  if (image.maxPixelValue <= image.minPixelValue) return false; // a flat image is legitimately uniform
  const voi = vp.getProperties?.()?.voiRange as { lower: number; upper: number } | undefined;
  if (!voi) return true;
  const invert = !!vp.getProperties?.()?.invert;
  // Some of the image must land above black inside the window.
  return invert ? image.minPixelValue < voi.upper : image.maxPixelValue > voi.lower;
}

export async function verifyPainted(
  engine: Engine | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vp: any,
  element: HTMLElement | null,
  ids: string[],
  index: number,
  /** False once a newer stack replaced this one (a growing scan): never judge a superseded paint. */
  isCurrent: () => boolean = () => true
): Promise<PaintHealth> {
  const cpu = () => !!engine?.core.getShouldUseCPURendering?.();
  // Sample the moment Cornerstone says it drew (IMAGE_RENDERED), not a fixed
  // number of frames later; a frame is the fallback for a hidden window.
  const rendered = () =>
    new Promise<void>((resolve) => {
      if (!element || !engine) return void nextFrame().then(resolve);
      const done = () => {
        element.removeEventListener(engine.core.Enums.Events.IMAGE_RENDERED, done);
        resolve();
      };
      element.addEventListener(engine.core.Enums.Events.IMAGE_RENDERED, done);
      // A real render, not a fixed 250 ms: a cold decode or a busy main
      // thread made the old timer sample an undrawn canvas.
      setTimeout(done, 750);
    });
  const simulate = await simulatingBlankGpu();
  const sample = () => (simulate && !cpu() ? 0 : sampleCanvas(element) ?? 0);
  // The canvas read-back forces a GPU sync: never in the same task as the
  // render it inspects (that task showed up as a 53–58 ms "load series" freeze).
  const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));
  const check = async (first: boolean): Promise<PaintHealth> => {
    await nextTask();
    // The first render may already have happened; if the canvas has pixels now, done.
    if (!first || !sample()) {
      await rendered();
      await nextTask();
    }
    const maxLum = sample();
    const visible = engine ? expectVisible(engine, vp, ids[index]) : true;
    return {
      maxLum,
      nonBlank: maxLum > 8,
      expectVisible: visible,
      renderPath: paintHealth.fellBack ? "cpu-fallback" : cpu() ? "cpu" : "gpu",
    };
  };
  // Judge only once the slice is decoded: wait for it (cold disc, slow decode)
  // rather than for a fixed 250 ms.
  if (engine && ids[index]) {
    const deadline = performance.now() + 15_000;
    while (!engine.core.cache.getImage(ids[index]) && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 16));
    }
  }
  let health = await check(true);
  // Confirm before giving up the GPU for the whole session (MPR and 3D cannot
  // run without it). A broken driver draws black on EVERY render; a stack being
  // re-set by a growing scan reads blank for a moment (measured: 347 of 848
  // slices in, decoded, window fine, canvas 0). Fall back only if four renders
  // 300 ms apart are all blank and this stack is still the current one
  // (about 1.5 s on a really broken driver).
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!engine || health.nonBlank || !health.expectVisible || cpu() || !isCurrent()) break;
    await new Promise((r) => setTimeout(r, 300));
    const again = check(false);
    vp.render?.();
    health = await again;
  }
  if (engine && !health.nonBlank && health.expectVisible && !cpu() && isCurrent()) {
    console.warn("RadLearn: the GPU path painted a blank viewport; switching to CPU rendering.", health);
    const image = engine.core.cache.getImage(ids[index]) as { minPixelValue?: number; maxPixelValue?: number } | undefined;
    paintHealth.fallbackWhy = {
      ...health,
      ids: ids.length,
      index,
      shownIndex: vp.getCurrentImageIdIndex?.(),
      shownIsChecked: vp.getCurrentImageId?.() === ids[index],
      min: image?.minPixelValue,
      max: image?.maxPixelValue,
      voi: vp.getProperties?.()?.voiRange,
      canvas: (() => {
        const c = element?.querySelector("canvas");
        return c ? [c.width, c.height] : null;
      })(),
    };
    paintHealth.fellBack = true;
    try {
      engine.core.setUseCPURendering(true);
      await vp.setStack(ids, index);
      const again = check(false);
      vp.render();
      health = await again;
    } catch (error) {
      console.error("RadLearn: CPU fallback failed", error);
    }
  }
  paintHealth.last = health;
  return health;
}
