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
export const paintHealth: { last?: PaintHealth; fellBack: boolean } = { fellBack: false };

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
/** rAF stops in a hidden or locked window; never wait on it forever. */
const nextFrame = () => Promise.race([frame(), new Promise<void>((r) => setTimeout(r, 250))]);

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
  if (!image || image.minPixelValue == null || image.maxPixelValue == null) return true;
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
  index: number
): Promise<PaintHealth> {
  const cpu = () => !!engine?.core.getShouldUseCPURendering?.();
  const check = async (): Promise<PaintHealth> => {
    await nextFrame();
    await nextFrame();
    const maxLum = sampleCanvas(element) ?? 0;
    const visible = engine ? expectVisible(engine, vp, ids[index]) : true;
    return {
      maxLum,
      nonBlank: maxLum > 8,
      expectVisible: visible,
      renderPath: paintHealth.fellBack ? "cpu-fallback" : cpu() ? "cpu" : "gpu",
    };
  };
  let health = await check();
  if (engine && !health.nonBlank && health.expectVisible && !cpu()) {
    console.warn("RadLearn: the GPU path painted a blank viewport; switching to CPU rendering.", health);
    paintHealth.fellBack = true;
    try {
      engine.core.setUseCPURendering(true);
      await vp.setStack(ids, index);
      vp.render();
      health = await check();
    } catch (error) {
      console.error("RadLearn: CPU fallback failed", error);
    }
  }
  paintHealth.last = health;
  return health;
}
