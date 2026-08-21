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
}: TabsProps) {
  const isUnderline = variant === "underline";
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
            ? "flex items-center gap-1 border-b border-subtle"
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
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
                "disabled:pointer-events-none disabled:opacity-40",
                isUnderline
                  ? cn(
                      "-mb-px rounded-t-md px-3 py-2.5",
                      active ? "text-primary" : "text-secondary hover:text-primary"
                    )
                  : cn(
                      "rounded-md px-3 py-1.5",
                      active ? "text-primary" : "text-secondary hover:text-primary"
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
