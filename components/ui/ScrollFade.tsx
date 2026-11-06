"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "./cn";

export interface ScrollFadeProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Classes for the scrolling element itself (its max height, padding,
   * layout). `className` goes on the outer, positioned wrapper.
   */
  scrollClassName?: string;
  /** The surface the list sits on, so the fade blends into it. Default: elevated (modals, menus). */
  surface?: "elevated" | "surface";
}

// The fade runs from the surface colour to the same colour at 0 alpha (Tailwind's
// default gradient end for a token colour), so it never greys the rows.
const FROM = { elevated: "from-elevated", surface: "from-surface" } as const;

/**
 * A vertically scrolling region with a soft fade at an edge that has more
 * content behind it, so a list cut mid-row reads as "scroll for more".
 * The fades follow the scroll position and the content size; they never
 * take pointer events. `data-more-above` / `data-more-below` on the wrapper
 * say which edges have more (tests, styling).
 */
export function ScrollFade({ className, scrollClassName, surface = "elevated", children, ...props }: ScrollFadeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ above: false, below: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 1 px of slack: fractional scroll positions on scaled displays.
    const above = el.scrollTop > 1;
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setMore((m) => (m.above === above && m.below === below ? m : { above, below }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    // Content that grows (a lazy panel, a row added) changes scrollHeight, not the box.
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(measure) : null;
    mo?.observe(el, { childList: true, subtree: true });
    for (const child of Array.from(el.children)) ro?.observe(child);
    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [measure]);

  return (
    <div
      className={cn("relative min-h-0", className)}
      data-scroll-fade=""
      data-more-above={more.above || undefined}
      data-more-below={more.below || undefined}
      {...props}
    >
      <div ref={ref} onScroll={measure} className={cn("overflow-y-auto overscroll-contain", scrollClassName)}>
        {children}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b transition-opacity duration-150",
          FROM[surface],
          more.above ? "opacity-100" : "opacity-0"
        )}
      />
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t transition-opacity duration-150",
          FROM[surface],
          more.below ? "opacity-100" : "opacity-0"
        )}
      />
    </div>
  );
}
