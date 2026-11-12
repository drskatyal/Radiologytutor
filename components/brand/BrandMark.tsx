import { cn } from "@/components/ui/cn";

/**
 * RadLearn mark: a slice stack plus the attending voice.
 * Cobalt square, white strokes. No reticle.
 */
export function BrandMark({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg" | "hero";
}) {
  const box =
    size === "hero"
      ? "h-16 w-16"
      : size === "lg"
        ? "h-12 w-12"
        : "h-8 w-8";

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-lg bg-accent text-white",
        box,
        className
      )}
      aria-hidden="true"
    >
      <svg viewBox="0 0 32 32" className="h-4/5 w-4/5" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <rect x="6" y="6" width="11" height="3" rx="1" opacity="0.5" />
        <rect x="6" y="11" width="15" height="3" rx="1" opacity="0.75" />
        <rect x="6" y="16" width="20" height="3" rx="1" />
        <rect x="8" y="22" width="2.2" height="5" rx="1" />
        <rect x="12.4" y="20" width="2.2" height="7" rx="1" />
        <rect x="16.8" y="22" width="2.2" height="5" rx="1" />
      </svg>
    </span>
  );
}

/** Wordmark. One typeface. "Learn" carries the signal color. */
export function Wordmark({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg" | "hero";
}) {
  const text =
    size === "hero"
      ? "text-4xl"
      : size === "lg"
        ? "text-2xl"
        : size === "sm"
          ? "text-sm"
          : "text-lg";

  return (
    <span className={cn("font-sans tracking-tight", text, className)}>
      <span className="font-medium text-primary">Rad</span>
      <span className="font-semibold text-accent">Learn</span>
    </span>
  );
}

export function BrandLockup({
  className,
  size = "md",
  href,
}: {
  className?: string;
  size?: "sm" | "md" | "lg" | "hero";
  href?: string;
}) {
  const content = (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <BrandMark size={size === "hero" ? "lg" : size} />
      <Wordmark size={size} />
    </span>
  );
  if (!href) return content;
  return (
    <a href={href} className="inline-flex rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      {content}
    </a>
  );
}
