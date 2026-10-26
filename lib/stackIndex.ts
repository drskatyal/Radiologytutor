// Where a stack viewport opens before Teach scrolls.
// CornerstoneViewer setStack and the DICOMweb warmer both use this so we
// prefetch the slice the learner actually sees, not the apex of the chest.

/** Initial image index for a stack of `imageCount` frames. Empty stacks stay at 0. */
export function stackOpenIndex(imageCount: number): number {
  if (!Number.isFinite(imageCount) || imageCount <= 0) return 0;
  return Math.floor(imageCount / 2);
}
