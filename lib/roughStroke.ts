/**
 * Seeded Rough.js strokes. The same mark id always wobbles the same way,
 * so a camera move can retarget the stroke without redrawing a new scribble.
 * Paths are in a local box. The overlay scales them onto the projected anatomy.
 */

import rough from "roughjs";

const generator = rough.generator();

export type RoughKind = "circle" | "ellipse" | "arrow" | "underline" | "leader" | "card";

function strokeOptions(seed: number, extra?: { roughness?: number; bowing?: number }) {
  return {
    seed,
    roughness: extra?.roughness ?? 1.15,
    bowing: extra?.bowing ?? 0.85,
    strokeWidth: 2.6,
    disableMultiStroke: true,
    maxRandomnessOffset: 1.5,
  };
}

export function sketchSeed(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function roughPaths(kind: RoughKind, seed: number): string[] {
  const drawable =
    kind === "circle"
      ? generator.circle(0, 0, 100, strokeOptions(seed))
      : kind === "ellipse"
        ? generator.ellipse(0, 0, 100, 72, strokeOptions(seed))
        : kind === "arrow"
          ? generator.line(0, 0, 100, 0, strokeOptions(seed, { bowing: 1.15 }))
          : kind === "leader"
            ? generator.line(0, 0, 100, 0, strokeOptions(seed, { roughness: 0.9, bowing: 0.45 }))
            : kind === "card"
              ? generator.rectangle(6, 6, 188, 78, strokeOptions(seed, { roughness: 1.35, bowing: 0.8 }))
              : generator.curve(
                  [
                    [0, 18],
                    [28, 4],
                    [62, 20],
                    [100, 6],
                  ],
                  strokeOptions(seed)
                );
  return generator
    .toPaths(drawable)
    .map((path) => path.d)
    .filter((d) => d.trim().length > 0);
}

/** Arrow head in a local box, tip at the origin, pointing +x. */
export function roughArrowHead(seed: number): string[] {
  const drawable = generator.linearPath(
    [
      [0, 0],
      [-28, -12],
      [-20, 0],
      [-28, 12],
      [0, 0],
    ],
    strokeOptions(seed, { roughness: 1.05, bowing: 0.4 })
  );
  return generator
    .toPaths(drawable)
    .map((path) => path.d)
    .filter((d) => d.trim().length > 0);
}

/** Draw-in stays inside the 0.4–0.8s window no matter the path length. */
export function drawDurationMs(kind: RoughKind | "card-in"): number {
  switch (kind) {
    case "circle":
      return 620;
    case "ellipse":
      return 700;
    case "arrow":
      return 560;
    case "underline":
      return 480;
    case "leader":
      return 420;
    case "card":
    case "card-in":
      return 640;
    default:
      return 600;
  }
}
