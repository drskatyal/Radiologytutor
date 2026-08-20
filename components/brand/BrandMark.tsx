import { cn } from "@/components/ui/cn";

/**
 * FlowRad brand mark — a film-window caliper + reticle.
 * Domain-authentic radiology motif; not a generic activity/pulse icon.
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
          ? "h-7 w-7"
          : "h-8 w-8";

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md",
        "border border-strong/80 bg-imaging text-accent",
        box,
        className
      )}
      aria-hidden="true"
    >
      <span
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(ellipse at 30% 20%, rgb(var(--accent) / 0.18), transparent 55%)",
        }}
      />
      <svg
        viewBox="0 0 32 32"
        className="relative h-[72%] w-[72%]"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Outer reticle */}
        <circle cx="16" cy="16" r="11.5" stroke="currentColor" strokeWidth="1.2" opacity="0.85" />
        <circle cx="16" cy="16" r="4.2" stroke="currentColor" strokeWidth="1.1" />
        {/* Crosshair */}
        <path
          d="M16 3.5v5.5M16 23v5.5M3.5 16h5.5M23 16h5.5"
          stroke="currentColor"
          strokeWidth="1.15"
          strokeLinecap="round"
        />
        {/* Caliper ticks — windowing motif */}
        <path
          d="M10 16h2.2M19.8 16H22"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          opacity="0.7"
        />
        <path
          d="M16 10v2.2M16 19.8V22"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          opacity="0.7"
        />
      </svg>
    </span>
  );
}

/** Editorial wordmark — FlowRad primary, Learn as quiet product line. */
export function Wordmark({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg" | "hero";
}) {
  const text =
    size === "hero"
      ? "text-4xl sm:text-5xl md:text-6xl"
      : size === "lg"
        ? "text-2xl sm:text-3xl"
        : size === "sm"
          ? "text-[15px]"
          : "text-lg";

  return (
    <span
      className={cn(
        "font-display font-semibold tracking-tightest text-primary",
        text,
        className
      )}
    >
      FlowRad{" "}
      <span className="font-normal text-secondary">Learn</span>
    </span>
  );
}

/** Brand lockup: mark + wordmark. */
export function BrandLockup({
  className,
  size = "md",
  href,
}: {
  className?: string;
  size?: "sm" | "md" | "lg" | "hero";
  href?: string;
}) {
  const gap = size === "hero" ? "gap-4" : size === "lg" ? "gap-3" : "gap-2.5";
  const content = (
    <span className={cn("inline-flex items-center", gap, className)}>
      <BrandMark size={size} />
      <Wordmark size={size} />
    </span>
  );
  if (!href) return content;
  return (
    <a href={href} className="inline-flex focus-visible:outline-none">
      {content}
    </a>
  );
}
