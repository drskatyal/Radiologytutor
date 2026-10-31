/**
 * Where a teaching card goes on the image.
 *
 * A radiologist's label sits in the black around the body, never on the
 * anatomy being taught. We sample the rendered viewport into a coarse
 * luminance grid, flood-fill the dark background from the edges (outside
 * air and letterbox, which are connected to the border; lung is not), then
 * pick the nearest spot where the whole card fits in that black. When no
 * spot fits (zoomed in, body fills the view) the darkest, flattest spot
 * near the finding wins.
 *
 * Pure. Coordinates are CSS pixels of the viewport.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LumaGrid {
  cols: number;
  rows: number;
  /** Cell edge in CSS px. */
  cell: number;
  /** Mean luminance 0–1 per cell, row-major. */
  data: Float32Array;
  /** Brightest sample per cell. A cell is background only if all of it is dark. */
  peak?: Float32Array;
}

/** Below this a cell counts as background (outside air reads ~0 on any window). */
export const BACKGROUND_LUMA = 0.085;

/**
 * Downsample RGBA pixels into a luminance grid of `cell` CSS px.
 * `scale` is device px per CSS px of the source canvas.
 */
export function lumaGrid(
  pixels: { width: number; height: number; data: ArrayLike<number> },
  cssSize: Size,
  cell = 12
): LumaGrid {
  const cols = Math.max(1, Math.ceil(cssSize.width / cell));
  const rows = Math.max(1, Math.ceil(cssSize.height / cell));
  const data = new Float32Array(cols * rows);
  const peak = new Float32Array(cols * rows);
  const sx = pixels.width / Math.max(1, cssSize.width);
  const sy = pixels.height / Math.max(1, cssSize.height);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor(c * cell * sx);
      const y0 = Math.floor(r * cell * sy);
      const x1 = Math.min(pixels.width, Math.floor((c + 1) * cell * sx));
      const y1 = Math.min(pixels.height, Math.floor((r + 1) * cell * sy));
      // Sample a 4×4 lattice per cell; enough to see a vessel, cheap.
      let sum = 0;
      let top = 0;
      let n = 0;
      for (let j = 0; j < 4; j++) {
        const y = Math.min(y1 - 1, y0 + Math.floor(((y1 - y0) * (j + 0.5)) / 4));
        for (let i = 0; i < 4; i++) {
          const x = Math.min(x1 - 1, x0 + Math.floor(((x1 - x0) * (i + 0.5)) / 4));
          if (x < 0 || y < 0) continue;
          const k = (y * pixels.width + x) * 4;
          const red = pixels.data[k] ?? 0;
          const green = pixels.data[k + 1] ?? 0;
          const blue = pixels.data[k + 2] ?? 0;
          const luma = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
          sum += luma;
          if (luma > top) top = luma;
          n++;
        }
      }
      data[r * cols + c] = n ? sum / n : 0;
      peak[r * cols + c] = top;
    }
  }
  return { cols, rows, cell, data, peak };
}

/** Dark cells connected to the viewport border. 1 = background. */
export function backgroundMask(grid: LumaGrid, threshold = BACKGROUND_LUMA): Uint8Array {
  const { cols, rows } = grid;
  const data = grid.peak ?? grid.data;
  const mask = new Uint8Array(cols * rows);
  const queue: number[] = [];
  const push = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return;
    const k = r * cols + c;
    if (mask[k] || (data[k] ?? 1) > threshold) return;
    mask[k] = 1;
    queue.push(k);
  };
  for (let c = 0; c < cols; c++) {
    push(c, 0);
    push(c, rows - 1);
  }
  for (let r = 0; r < rows; r++) {
    push(0, r);
    push(cols - 1, r);
  }
  while (queue.length) {
    const k = queue.pop()!;
    const c = k % cols;
    const r = (k - c) / cols;
    push(c + 1, r);
    push(c - 1, r);
    push(c, r + 1);
    push(c, r - 1);
  }
  return mask;
}

function boxStats(grid: LumaGrid, mask: Uint8Array | null, box: Box) {
  const c0 = Math.max(0, Math.floor(box.x / grid.cell));
  const r0 = Math.max(0, Math.floor(box.y / grid.cell));
  const c1 = Math.min(grid.cols - 1, Math.floor((box.x + box.width - 1) / grid.cell));
  const r1 = Math.min(grid.rows - 1, Math.floor((box.y + box.height - 1) / grid.cell));
  let sum = 0;
  let bg = 0;
  const values: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const k = r * grid.cols + c;
      const v = grid.data[k] ?? 0;
      sum += v;
      values.push(v);
      if (mask?.[k]) bg++;
    }
  }
  const n = values.length;
  // 90th percentile, not the max: one bright cell where the body meets a
  // narrow letterbox must not push the card across the room.
  values.sort((a, b) => a - b);
  const p90 = n ? values[Math.min(n - 1, Math.floor(n * 0.9))]! : 1;
  return { mean: n ? sum / n : 1, p90, background: n ? bg / n : 0 };
}

export interface CardPlacement extends Box {
  /** Share of the card over background (outside the body). */
  background: number;
  /** Lower is better; comparable across card sizes for the same anchor. */
  cost: number;
  /** Direction from the anchor to the card, radians. */
  angle: number;
}

/**
 * Seat a card next to a ring. The card never overlaps the ring, stays inside
 * the viewport, and prefers black space; among equals, closer wins.
 */
export function placeCard(input: {
  anchor: { x: number; y: number };
  ringRadius: number;
  card: Size;
  viewport: Size;
  grid?: LumaGrid | null;
  margin?: number;
  /** Viewer chrome the card must not cover. */
  avoid?: readonly Box[];
}): CardPlacement {
  const { anchor, card, viewport } = input;
  const margin = input.margin ?? 12;
  const ring = Math.max(8, input.ringRadius);
  const grid = input.grid ?? null;
  const mask = grid ? backgroundMask(grid) : null;
  const diag = Math.hypot(viewport.width, viewport.height) || 1;
  const maxX = Math.max(margin, viewport.width - card.width - margin);
  const maxY = Math.max(margin, viewport.height - card.height - margin);
  const gaps = [26, 56, 96, 150, 220, 300];
  let best: { cost: number; place: CardPlacement } | null = null;

  for (let step = 0; step < 24; step++) {
    const angle = (step / 24) * Math.PI * 2;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    // Half the card's extent along the ray, so `gap` is edge-to-ring.
    const half = Math.abs(ux) * (card.width / 2) + Math.abs(uy) * (card.height / 2);
    for (const gap of gaps) {
      const reach = ring + gap + half;
      const cx = anchor.x + ux * reach;
      const cy = anchor.y + uy * reach;
      const rawX = cx - card.width / 2;
      const rawY = cy - card.height / 2;
      const x = Math.min(maxX, Math.max(margin, rawX));
      const y = Math.min(maxY, Math.max(margin, rawY));
      const box = { x, y, width: card.width, height: card.height };
      // Clear of the ring with a little air.
      const nx = Math.min(Math.max(anchor.x, x), x + card.width);
      const ny = Math.min(Math.max(anchor.y, y), y + card.height);
      const clearance = Math.hypot(anchor.x - nx, anchor.y - ny);
      if (clearance < ring + 14) continue;
      if ((input.avoid ?? []).some((zone) => overlaps(box, zone))) continue;
      const shifted = Math.hypot(x - rawX, y - rawY);
      let cost = (clearance / diag) * 2.6 + (shifted > 1 ? 0.25 + shifted / diag : 0);
      // Side-by-side reads better than above/below on a landscape image.
      cost += Math.abs(uy) * 0.18;
      let background = 0;
      if (grid) {
        const stats = boxStats(grid, mask, box);
        background = stats.background;
        cost += (1 - stats.background) * 5 + stats.mean * 2.5 + stats.p90 * 1.2;
        // Touching the body at all is worse than a little more leader.
        if (stats.background < 0.999) cost += 0.5;
      } else {
        // No pixels: lean toward the side with more room.
        const room = ux >= 0 ? viewport.width - anchor.x : anchor.x;
        cost += (1 - room / Math.max(1, viewport.width)) * 0.6;
      }
      if (!best || cost < best.cost) best = { cost, place: { ...box, background, angle, cost } };
    }
  }

  if (best) return best.place;
  // Viewport smaller than card + ring: pin to the corner farthest from the anchor.
  const x = anchor.x < viewport.width / 2 ? maxX : margin;
  const y = anchor.y < viewport.height / 2 ? maxY : margin;
  return {
    x,
    y,
    width: card.width,
    height: card.height,
    background: 0,
    angle: Math.atan2(y - anchor.y, x - anchor.x),
    cost: Number.POSITIVE_INFINITY,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** True when a placed card no longer fits the view or touches the ring. */
export function cardNeedsReseat(box: Box, anchor: { x: number; y: number }, ringRadius: number, viewport: Size): boolean {
  const off =
    box.x < -box.width * 0.15 ||
    box.y < -box.height * 0.15 ||
    box.x + box.width > viewport.width + box.width * 0.15 ||
    box.y + box.height > viewport.height + box.height * 0.15;
  if (off) return true;
  const nx = Math.min(Math.max(anchor.x, box.x), box.x + box.width);
  const ny = Math.min(Math.max(anchor.y, box.y), box.y + box.height);
  return Math.hypot(anchor.x - nx, anchor.y - ny) < ringRadius + 6;
}

/** Point on the card border facing the anchor — where the leader leaves the card. */
export function cardEdgeToward(box: Box, target: { x: number; y: number }): { x: number; y: number } {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: box.y + box.height };
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : box.width / 2 / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : box.height / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** Card width in CSS px for a viewport. */
export function cardWidthFor(viewportWidth: number): number {
  return viewportWidth < 520 ? Math.min(212, viewportWidth - 32) : 256;
}

/**
 * Try the card at a few widths (text reflows, so a narrower card is taller)
 * and keep the best seat. A slim card in the black beside the body beats a
 * wide one across the room. `heightAt` estimates height for a width.
 */
export function placeCardFlexible(
  input: Omit<Parameters<typeof placeCard>[0], "card"> & {
    widths: readonly number[];
    heightAt: (width: number) => number;
  }
): CardPlacement {
  let best: CardPlacement | null = null;
  input.widths.forEach((width, index) => {
    const place = placeCard({ ...input, card: { width, height: input.heightAt(width) } });
    // Prefer the default width when seats are otherwise equal.
    const cost = place.cost + index * 0.12;
    if (!best || cost < best.cost) best = { ...place, cost };
  });
  return best!;
}
