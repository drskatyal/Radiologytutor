"use client";

import { cn } from "./cn";

export interface TabItem {
  value: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  /** Optional trailing count / badge. */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  /** Segmented (pill group) or underlined tab style. */
  variant?: "segmented" | "underline";
}

/** Controlled tab switcher. Roving via native button focus + arrow keys. */
export function Tabs({
  items,
  value,
  onValueChange,
  className,
  variant = "segmented",
}: TabsProps) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const idx = items.findIndex((i) => i.value === value);
    const dir = e.key === "ArrowRight" ? 1 : -1;
    for (let n = 1; n <= items.length; n++) {
      const next = items[(idx + dir * n + items.length * n) % items.length];
      if (next && !next.disabled) {
        onValueChange(next.value);
        break;
      }
    }
  };

  if (variant === "underline") {
    return (
      <div
        role="tablist"
        onKeyDown={onKeyDown}
        className={cn("flex items-center gap-1 border-b border-subtle", className)}
      >
        {items.map((item) => {
          const active = item.value === value;
          return (
            <button
              key={item.value}
              role="tab"
              type="button"
              aria-selected={active}
              disabled={item.disabled}
              tabIndex={active ? 0 : -1}
              onClick={() => onValueChange(item.value)}
              className={cn(
                "relative -mb-px flex items-center gap-2 px-3 py-2.5 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas rounded-t-md",
                "disabled:opacity-40 disabled:pointer-events-none",
                active
                  ? "border-b-2 border-accent text-primary"
                  : "border-b-2 border-transparent text-secondary hover:text-primary"
              )}
            >
              {item.icon}
              {item.label}
              {typeof item.count === "number" && (
                <span className="rounded-full bg-elevated px-1.5 text-xs tabular-nums text-muted">
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="tablist"
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border border-subtle bg-surface p-1",
        className
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={item.disabled}
            tabIndex={active ? 0 : -1}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
              "disabled:opacity-40 disabled:pointer-events-none",
              active
                ? "bg-elevated text-primary shadow-sm"
                : "text-secondary hover:text-primary"
            )}
          >
            {item.icon}
            {item.label}
            {typeof item.count === "number" && (
              <span className="rounded-full bg-canvas px-1.5 text-xs tabular-nums text-muted">
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
