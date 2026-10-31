"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Keyboard-navigable menu (arrow keys, Home/End, typeahead, Escape) on Radix.
 * Imaging-dark: the viewer toolbar is the first user. Pass `container` when
 * the trigger can live inside a fullscreen element.
 */
export function Menu({
  trigger,
  label,
  container,
  side = "top",
  align = "start",
  open,
  onOpenChange,
  children,
}: {
  /** A single `<button>` (forwards refs). */
  trigger: ReactNode;
  label: string;
  container?: HTMLElement | null;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dropdown.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal container={container ?? undefined}>
        <Dropdown.Content
          aria-label={label}
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          data-viewer-menu=""
          className={cn(
            "z-[80] max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-52 overflow-y-auto overscroll-contain",
            "rounded-lg border border-white/10 bg-[#181818] p-1 text-white shadow-xl"
          )}
        >
          {children}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** One radio-style row: label left, tabular hint right, check when active. */
export function MenuItem({
  label,
  hint,
  active = false,
  disabled = false,
  shortcut,
  onSelect,
}: {
  label: string;
  hint?: string;
  active?: boolean;
  disabled?: boolean;
  shortcut?: string | null;
  onSelect: () => void;
}) {
  return (
    <Dropdown.Item
      disabled={disabled}
      onSelect={onSelect}
      aria-checked={active}
      role="menuitemradio"
      className={cn(
        "flex min-h-9 cursor-pointer select-none items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-xs outline-none transition-colors duration-75",
        "data-[highlighted]:bg-white/10 data-[highlighted]:text-white",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
        "active:bg-white/15 [@media(pointer:coarse)]:min-h-11",
        active ? "text-white" : "text-white/85"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          active ? "bg-accent" : "bg-transparent"
        )}
      />
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      {hint ? <span className="shrink-0 tabular-nums text-white/55">{hint}</span> : null}
      {shortcut ? (
        <kbd className="shrink-0 rounded border border-white/15 px-1 font-sans text-[11px] leading-4 text-white/60">
          {shortcut}
        </kbd>
      ) : null}
    </Dropdown.Item>
  );
}

export function MenuSeparator() {
  return <Dropdown.Separator className="my-1 h-px bg-white/10" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <Dropdown.Label className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-white/45">
      {children}
    </Dropdown.Label>
  );
}
