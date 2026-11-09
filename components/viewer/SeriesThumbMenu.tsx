"use client";

// A series thumbnail's right-click menu (the shared thumbnailMenu model, as on
// the desktop). Its own module so the menu code loads on the first
// right-click, not with the viewer page.

import { thumbnailMenu, type MenuCommand } from "@flowrad/viewer-core";
import { ViewerContextMenu } from "./ViewerContextMenu";

export function SeriesThumbMenu({
  at,
  canAddPane,
  canReformat,
  onSelect,
  onClose,
}: {
  at: { x: number; y: number };
  canAddPane: boolean;
  /** A stack of parallel slices: offer Quick coronal / sagittal. */
  canReformat: boolean;
  onSelect: (command: MenuCommand) => void;
  onClose: () => void;
}) {
  return (
    <ViewerContextMenu
      at={at}
      label="Series"
      entries={thumbnailMenu({ can: { newLayout: canAddPane, reformat: canReformat, info: true, hide: true }, shortcut: () => undefined })}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}
