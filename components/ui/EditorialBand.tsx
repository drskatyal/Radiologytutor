import { cn } from "./cn";

export interface EditorialBandProps {
  /** Band headline — display serif. */
  title: React.ReactNode;
  /** Supporting copy below the title. */
  description?: React.ReactNode;
  /** Trailing CTA slot — Button, Link, or text action. */
  action?: React.ReactNode;
  /** `accent` adds a left film-marker hairline. */
  variant?: "default" | "accent";
  className?: string;
}

/**
 * Full-width CTA / callout band for marketplace surfaces.
 * No rounded Card — editorial spacing with a top hairline.
 */
export function EditorialBand({
  title,
  description,
  action,
  variant = "default",
  className,
}: EditorialBandProps) {
  return (
    <section
      className={cn(
        "border-t border-subtle py-6 sm:py-8",
        variant === "accent" && "border-l-2 border-l-accent pl-4 sm:pl-6",
        className
      )}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold tracking-tight text-primary sm:text-xl">
            {title}
          </h2>
          {description ? (
            <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </section>
  );
}
