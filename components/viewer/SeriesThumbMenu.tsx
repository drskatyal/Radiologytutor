"use client";

// A series thumbnail's right-click menu (the shared thumbnailMenu model, as on
// the desktop). Its own module so the menu code loads on the first
// right-click, not with the viewer page.

import { thumbnailMenu, type MenuCommand } from "@flowrad/viewer-core";
import { ViewerContextMenu } from "./ViewerContextMenu";

export function SeriesThumbMenu({
  at,
  canAddPane,
  onSelect,
  onClose,
}: {
  at: { x: number; y: number };
  canAddPane: boolean;
  onSelect: (command: MenuCommand) => void;
  onClose: () => void;
}) {
  return (
    <ViewerContextMenu
      at={at}
      label="Series"
      entries={thumbnailMenu({ can: { newLayout: canAddPane }, shortcut: () => undefined })}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}
