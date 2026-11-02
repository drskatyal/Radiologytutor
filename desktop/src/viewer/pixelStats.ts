// Bench-only: statistics of the decoded pixels of the first image of the
// hung series, for desktop/scripts/codec-check.py to compare against an
// independent decoder. Exact for lossless codecs (integer sum/min/max over
// every pixel), tolerance-checked for lossy ones.

import { primarySeriesIndex } from "../study";
import type { ViewerStudy } from "../types";
import { getEngine } from "./engine";

export interface PixelStats {
  file: string;
  frame: number;
  count: number;
  min: number;
  max: number;
  sum: number;
  /** True when Cornerstone applied RescaleSlope/Intercept before returning pixels. */
  scaled: boolean;
}

/** Pure: the numbers the check compares. */
export function pixelStats(values: ArrayLike<number>): Pick<PixelStats, "count" | "min" | "max" | "sum"> {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { count: values.length, min, max, sum };
}

export async function firstImagePixelStats(studies: ViewerStudy[]): Promise<PixelStats> {
  const study = studies[0];
  const series = study.series[primarySeriesIndex(study)];
  const imageId = series.imageIds[0];
  const { core } = await getEngine();
  const image = (core.cache.getImage(imageId) ?? (await core.imageLoader.loadAndCacheImage(imageId))) as {
    getPixelData(): ArrayLike<number>;
    preScale?: { scaled?: boolean };
  };
  const frame = Number(/[?&]frame=(\d+)/.exec(imageId)?.[1] ?? 1);
  return { file: series.headers[0].fileName, frame, scaled: !!image.preScale?.scaled, ...pixelStats(image.getPixelData()) };
}
