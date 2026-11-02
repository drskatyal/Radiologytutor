"use client";

import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Hover / focus label with an optional shortcut. Imaging-dark by default: it
 * is used on the viewer toolbar, where paper surfaces wash out.
 *
 * `container` matters in fullscreen: a portal to `document.body` is hidden
 * under the fullscreen element, so the viewer passes the element it is in.
 */
export function Tooltip({
  label,
  shortcut,
  side = "top",
  container,
  disabled = false,
  children,
}: {
  label: ReactNode;
  /** Keys rendered as chips after the label, e.g. ["2", "W"]. */
  shortcut?: string[] | null;
  side?: "top" | "bottom" | "left" | "right";
  container?: HTMLElement | null;
  disabled?: boolean;
  /** Must be a single element that forwards refs (a `<button>`). */
  children: ReactNode;
}) {
  if (disabled) return <>{children}</>;
  return (
    <RadixTooltip.Provider delayDuration={350} skipDelayDuration={150}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal container={container ?? undefined}>
          <RadixTooltip.Content
            side={side}
            sideOffset={8}
            collisionPadding={8}
            className={cn(
              "z-[90] flex select-none items-center gap-2 rounded-md border border-white/10 bg-[#181818] px-2 py-1",
              "text-xs font-medium text-white shadow-lg"
            )}
          >
            <span>{label}</span>
            {shortcut && shortcut.length > 0 ? (
              <span className="flex items-center gap-1">
                {shortcut.map((key) => (
                  <kbd
                    key={key}
                    className="min-w-[1.25rem] rounded border border-white/15 bg-white/5 px-1 text-center font-sans text-[11px] font-medium leading-4 text-white/80"
                  >
                    {key}
                  </kbd>
                ))}
              </span>
            ) : null}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
