"use client";

// A side panel that collapses to a slim rail (the viewer's series panel).
//
// The content stays mounted while collapsed (inert, out of the tab order), so
// reopening is instant: nothing it rendered — thumbnails included — is built
// again. The width change is one short transition; the viewports beside it
// re-fit through their own resize observers (cached pixels, no re-decode).

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "./cn";
import { Tooltip } from "./Tooltip";

export function CollapsiblePanel({
  collapsed,
  onToggle,
  label,
  shortcut,
  widthClassName,
  tone = "imaging",
  className,
  children,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** Names the region and the handle ("Series"). */
  label: string;
  /** Shown in the handle's tooltip, e.g. ["Ctrl", "B"]. */
  shortcut?: string[];
  /** Static Tailwind width of the open panel, e.g. "w-72". */
  widthClassName: string;
  /** "imaging" on the black reading room, "surface" on the desktop chrome. */
  tone?: "imaging" | "surface";
  className?: string;
  children: ReactNode;
}) {
  // `inert` is set on the element: React 18 has no prop for it.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (collapsed) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }, [collapsed]);
  const action = collapsed ? `Show ${label.toLowerCase()} panel` : `Hide ${label.toLowerCase()} panel`;
  const handle = cn(
    "flex items-center justify-center rounded-md transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
    tone === "imaging" ? "text-white/60 hover:bg-white/10 hover:text-white" : "text-muted hover:bg-overlay hover:text-primary"
  );
  return (
    <aside
      aria-label={label}
      data-collapsed={collapsed ? "true" : undefined}
      className={cn(
        "relative flex shrink-0 flex-col overflow-hidden border-r transition-[width] duration-150 ease-out motion-reduce:transition-none",
        tone === "imaging" ? "border-white/10 bg-imaging" : "border-subtle bg-surface",
        collapsed ? "w-7" : widthClassName,
        className
      )}
    >
      {collapsed ? (
        <Tooltip label={action} shortcut={shortcut} side="right">
          <button
            type="button"
            aria-label={action}
            aria-expanded={false}
            onClick={onToggle}
            className={cn(handle, "absolute inset-0 flex-col justify-start gap-2 rounded-none pt-3")}
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
            <span className="text-[10px] font-medium uppercase tracking-wider [writing-mode:vertical-rl]">{label}</span>
          </button>
        </Tooltip>
      ) : (
        // Open: a slim header row — the panel's name, and the collapse chevron on its edge.
        <div className="flex h-8 shrink-0 items-center justify-between pl-3 pr-1">
          <span className={cn("text-[11px] font-medium uppercase tracking-wider", tone === "imaging" ? "text-white/50" : "text-muted")}>
            {label}
          </span>
          <Tooltip label={action} shortcut={shortcut} side="right">
            <button type="button" aria-label={action} aria-expanded onClick={onToggle} className={cn(handle, "h-6 w-6")}>
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
          </Tooltip>
        </div>
      )}
      <div
        // Kept mounted when collapsed: inert and hidden, not rebuilt on reopen.
        ref={contentRef}
        aria-hidden={collapsed || undefined}
        // Its own fixed width: the content does not reflow while the panel animates.
        className={cn("flex min-h-0 flex-1 flex-col", widthClassName, collapsed && "invisible")}
      >
        {children}
      </div>
    </aside>
  );
}
