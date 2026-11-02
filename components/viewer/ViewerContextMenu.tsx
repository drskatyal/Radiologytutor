"use client";

// The viewer's right-click menu, desktop and web: renders the shared menu
// model (`@flowrad/viewer-core` contextMenu.ts) at the click, with the
// keyboard shortcut beside each item. Submenus build their items only when
// opened. FlowRad imaging-dark, from the design-system Menu.

import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuSub } from "@/components/ui/Menu";
import type { MenuCommand, MenuEntry } from "@flowrad/viewer-core";

/** Wider than a toolbar menu (item, value, shortcut), as tall as the screen allows. */
const PANEL = "w-72 max-h-[var(--radix-dropdown-menu-content-available-height)]";

export interface ViewerContextMenuProps {
  /** Where the menu opens (viewport/page coordinates of the click); null: closed. */
  at: { x: number; y: number } | null;
  entries: readonly MenuEntry[];
  onSelect: (command: MenuCommand) => void;
  onClose: () => void;
  label?: string;
  /** Portal container (fullscreen element). */
  container?: HTMLElement | null;
  /** Positioning: "fixed" for page coordinates, "absolute" inside a positioned parent. */
  position?: "fixed" | "absolute";
}

export function ViewerContextMenu({ at, entries, onSelect, onClose, label = "Viewer", container, position = "fixed" }: ViewerContextMenuProps) {
  if (!at) return null;
  const render = (list: readonly MenuEntry[]) =>
    list.map((e, i) => {
      switch (e.kind) {
        case "sep":
          return <MenuSeparator key={`sep-${i}`} />;
        case "label":
          return <MenuLabel key={`label-${e.label}`}>{e.label}</MenuLabel>;
        case "sub":
          return (
            <MenuSub key={e.id} label={e.label} hint={e.hint} container={container} contentClassName={PANEL}>
              {render(e.items())}
            </MenuSub>
          );
        default:
          return (
            <MenuItem
              key={e.id}
              label={e.label}
              hint={e.hint}
              shortcut={e.shortcut}
              active={e.checked}
              disabled={e.disabled}
              swatch={e.swatch}
              onSelect={() => onSelect(e.id)}
            />
          );
      }
    });
  return (
    // Pointer events stop here so the viewer's own press handlers never see
    // the click that chose an item (Radix portals bubble through React).
    <div className="contents" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <Menu
        label={label}
        open
        onOpenChange={(open) => !open && onClose()}
        side="bottom"
        align="start"
        container={container}
        contentClassName={PANEL}
        trigger={
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className={`pointer-events-none ${position} z-[79] h-px w-px opacity-0`}
            // Dynamic geometry: anchors the menu at the click.
            style={{ left: at.x, top: at.y }}
          />
        }
      >
        <div data-testid="viewer-context-menu">{render(entries)}</div>
      </Menu>
    </div>
  );
}
