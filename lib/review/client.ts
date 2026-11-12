import type { RenderConfirmedViewer } from "../viewerController";
import { matchesView } from "../journal/match";
import type { FindingReviewState } from "./model";
import type { ImagePointEvidence } from "../journal/viewer";
let generation = 0;
/** One author jump at a time across cards; only its matching render can confirm it. */
export async function jumpToReview(viewer: Partial<RenderConfirmedViewer> | null, review: FindingReviewState) {
  if (!viewer?.requestView || !review.snapshot || review.anchorStatus !== "resolved") throw new Error(review.anchorStatus === "unresolved" ? "Image not found: rebind" : "Incomplete image anchor: rebind");
  const next = ++generation, commandId = `review-${next}`;
  try {
    const ack = await viewer.requestView({ commandId, generation: next, snapshot: review.snapshot, timeoutMs: 8000 });
    if (generation !== next || ack.commandId !== commandId || ack.generation !== next || !matchesView(ack.snapshot, review.snapshot)) throw new Error("View request superseded. Jump again.");
    return ack;
  } catch (err) {
    if ((err as { code?: string }).code === "missing_identity") throw new Error("Image not found: rebind");
    throw err;
  }
}
export function captureReviewPoint(viewer: Partial<RenderConfirmedViewer> | null): ImagePointEvidence {
  // The author explicitly places the desired point at the viewport centre.
  const evidence = viewer?.captureImagePoint?.(.5, .5), rendered = viewer?.getRenderedView?.();
  if (!evidence || !rendered || evidence.snapshot.renderSeq !== rendered.snapshot.renderSeq || !matchesView(evidence.snapshot, rendered.snapshot)) throw new Error("Wait for the image to render, then centre the finding and rebind.");
  return evidence;
}
export async function reviewRequest<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error ?? "Review request failed"), { status: res.status });
  return data;
}
