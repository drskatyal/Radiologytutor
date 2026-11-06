"use client";

import { useId } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { motion } from "framer-motion";
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
  /** "imaging": on the viewer's always-dark surfaces, whatever the app theme. */
  tone?: "default" | "imaging";
}

/**
 * Controlled tab switcher built on Radix Tabs (roving focus, arrow-key nav,
 * ARIA). A shared `layoutId` gives the active state a smooth sliding indicator.
 * Same controlled `TabsProps` API as before.
 */
export function Tabs({
  items,
  value,
  onValueChange,
  className,
  variant = "segmented",
  tone = "default",
}: TabsProps) {
  const isUnderline = variant === "underline";
  const imaging = tone === "imaging";
  const on = imaging ? "text-white" : "text-primary";
  const off = imaging ? "text-white/60 hover:text-white" : "text-secondary hover:text-primary";
  // Scope the sliding-indicator animation to this instance so multiple Tabs on
  // one page never share (and fight over) a layout animation.
  const layoutGroup = useId();

  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      activationMode="automatic"
    >
      <TabsPrimitive.List
        className={cn(
          isUnderline
            ? cn("flex items-center gap-1 border-b", imaging ? "border-white/10" : "border-subtle")
            : imaging
              ? "inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 p-1"
              : "inline-flex items-center gap-1 rounded-lg border border-subtle bg-surface p-1 shadow-sm surface-hairline",
          className
        )}
      >
        {items.map((item) => {
          const active = item.value === value;
          return (
            <TabsPrimitive.Trigger
              key={item.value}
              value={item.value}
              disabled={item.disabled}
              className={cn(
                "relative flex items-center gap-2 text-sm font-medium transition-colors",
                imaging
                  ? "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  : "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
                "disabled:pointer-events-none disabled:opacity-40",
                isUnderline
                  ? cn(
                      "-mb-px rounded-t-md px-3 py-2.5",
                      active ? on : off
                    )
                  : cn(
                      "rounded-md px-3 py-1.5",
                      active ? on : off
                    )
              )}
            >
              {active && (
                <motion.span
                  layoutId={isUnderline ? undefined : `tab-pill-${layoutGroup}`}
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-0 -z-10",
                    isUnderline
                      ? "rounded-none"
                      : imaging
                        ? "rounded-md bg-white/15"
                        : "rounded-md bg-elevated shadow-sm"
                  )}
                  transition={{ type: "spring", duration: 0.3, bounce: 0.18 }}
                />
              )}
              {item.icon}
              {item.label}
              {typeof item.count === "number" && (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-xs tabular-nums text-muted",
                    isUnderline ? "bg-elevated" : "bg-canvas"
                  )}
                >
                  {item.count}
                </span>
              )}
              {isUnderline && active && (
                <motion.span
                  layoutId={`tab-underline-${layoutGroup}`}
                  aria-hidden="true"
                  className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-accent"
                  transition={{ type: "spring", duration: 0.3, bounce: 0.18 }}
                />
              )}
            </TabsPrimitive.Trigger>
          );
        })}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}
