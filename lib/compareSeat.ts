// When Compare may drive the secondary viewport.
//
// Opening compare mounts a stack at the mid-slice default (display 33/65 on
// the LIDC chest) with that image's own window. The authored secondary
// landing has to be applied after the pane reports ready. A later ready —
// the pane remounted, `secondaryReady` was already true — is a new viewport
// sitting on that default again and must be seated too. Closing compare
// bumps the open generation so an in-flight seat cannot paint the pane.

import type { SecondaryViewState } from "./findingAnchors";

export type CompareSeatPlan =
  | { action: "skip"; reason: "closed" | "stale" | "no-landing" | "already-seated" }
  | { action: "defer"; view: SecondaryViewState }
  | { action: "apply"; view: SecondaryViewState };

export function compareSeatKey(viewportGeneration: number, findingId: string): string {
  return `${viewportGeneration}:${findingId}`;
}

/**
 * Decide what the compare pane should do for this finding.
 * `viewportGeneration` is 0 until the pane's controls exist. It bumps on
 * every ready callback, including a remount that does not clear the ready flag.
 */
export function planCompareSeat(args: {
  compareOpen: boolean;
  /** Generation captured when this seat was requested. */
  openGeneration: number;
  /** Live generation. Close increments it; a request from the previous open is stale. */
  liveGeneration: number;
  /** 0 while the compare viewport has no controls. */
  viewportGeneration: number;
  /** `compareSeatKey` of the last successful apply. Empty if none. */
  seatedKey: string;
  findingId: string;
  view: SecondaryViewState | null;
}): CompareSeatPlan {
  if (!args.compareOpen) return { action: "skip", reason: "closed" };
  if (args.openGeneration !== args.liveGeneration) return { action: "skip", reason: "stale" };
  if (!args.view) return { action: "skip", reason: "no-landing" };
  if (args.viewportGeneration <= 0) return { action: "defer", view: args.view };
  if (args.seatedKey === compareSeatKey(args.viewportGeneration, args.findingId)) {
    return { action: "skip", reason: "already-seated" };
  }
  return { action: "apply", view: args.view };
}
