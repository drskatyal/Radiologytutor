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
    roughness: extra?.roughness ?? 1.75,
    bowing: extra?.bowing ?? 2.1,
    strokeWidth: 3.1,
    disableMultiStroke: false,
    maxRandomnessOffset: 2.6,
    curveFitting: 0.92,
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
      ? generator.arc(0, 0, 108, 108, -0.45, Math.PI * 2 + 0.62, false, strokeOptions(seed, { roughness: 1.85, bowing: 2.4 }))
      : kind === "ellipse"
        ? generator.ellipse(0, 0, 108, 78, strokeOptions(seed, { roughness: 1.7 }))
        : kind === "arrow"
          ? generator.line(0, 0, 100, 0, strokeOptions(seed, { roughness: 1.6, bowing: 1.8 }))
          : kind === "leader"
            ? generator.curve(
                [
                  [0, 8],
                  [18, -6],
                  [42, 14],
                  [68, -4],
                  [100, 6],
                ],
                strokeOptions(seed, { roughness: 1.9, bowing: 2.6 })
              )
            : kind === "card"
              ? generator.rectangle(4, 4, 192, 82, strokeOptions(seed, { roughness: 1.5, bowing: 1.2 }))
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
      return 420;
    default:
      return 600;
  }
}
