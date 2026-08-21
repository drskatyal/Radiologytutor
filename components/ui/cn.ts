/**
 * Class-name combiner used across the design system.
 *
 * Built on `clsx` (conditional joins) + `tailwind-merge` (last-wins conflict
 * resolution) so component callers can safely override Tailwind utilities via a
 * `className` prop without fighting specificity. The exported `ClassValue` type
 * and `cn(...)` signature are unchanged from the original hand-rolled helper, so
 * every existing import keeps working.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export type { ClassValue };

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
