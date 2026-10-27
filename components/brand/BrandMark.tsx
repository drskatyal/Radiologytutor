import { cn } from "@/components/ui/cn";

/**
 * RadLearn mark. A reticle on black, drawn as a single stroke weight.
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
        : size === "sm"
          ? "h-8 w-8"
          : "h-8 w-8";

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-lg bg-imaging text-primary",
        box,
        className
      )}
      aria-hidden="true"
    >
      <svg viewBox="0 0 32 32" className="h-4/5 w-4/5" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="16" cy="16" r="11" stroke="currentColor" strokeWidth="1.25" />
        <circle cx="16" cy="16" r="3.5" stroke="currentColor" strokeWidth="1.25" />
        <path d="M16 3.5v5M16 23.5V29M3.5 16h5M23.5 16H29" stroke="currentColor" strokeWidth="1.25" />
      </svg>
    </span>
  );
}

/** Wordmark. One typeface, one weight step, no second color split. */
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
    <span className={cn("font-sans font-semibold tracking-tight text-primary", text, className)}>
      RadLearn
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
