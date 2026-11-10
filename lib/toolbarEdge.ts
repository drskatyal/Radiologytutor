// Where a scrolling toolbar's cut edge ends (components/viewer/ViewerToolbar).
// The chevron sits on solid black; when a control would show half under it
// (a selected tool is white: a stray sliver), the black snaps outward to the
// gap before that control so the row always ends on whole buttons. Pure.

/** The chevron's own solid width, and the widest an edge will grow to snap. */
export const EDGE_SOLID_PX = 36;
export const EDGE_COVER_MAX = 120;
/** The fade beside the chevron's black (Tailwind w-5). */
export const EDGE_FADE_PX = 20;

/**
 * Width of an edge's solid black so it ends between controls, not across one.
 * `spans` are each control's distance from the edge (`from` near side, `to`
 * far side). Grows past every control the chevron's black or fade would
 * overlap; 0 when nothing is, or when only a group wider than the cap is.
 */
export function edgeSnap(spans: readonly { from: number; to: number }[]): number {
  let cover = EDGE_SOLID_PX;
  // Anything under the chevron's black or its fade starts a snap…
  let cut = spans.find((s) => s.to > cover && s.from < cover + EDGE_FADE_PX);
  let snapped = false;
  // …then the black grows to whole controls (a snapped edge draws no fade).
  for (let pass = 0; cut && pass < 8; pass += 1) {
    if (cut.to + 1 > EDGE_COVER_MAX) return 0;
    cover = cut.to + 1;
    snapped = true;
    cut = spans.find((s) => s.from < cover && s.to > cover);
  }
  return snapped ? Math.ceil(cover) : 0;
}
