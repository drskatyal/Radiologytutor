import { cn } from "@/components/ui/cn";

/**
 * Case thumbnail: a short stack, then a black viewport.
 * The viewport is the study. The page around it stays paper.
 */
export function FilmPlane({
  modality,
  className,
  children,
}: {
  modality?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const label = (modality || "DX").slice(0, 4).toUpperCase();
  return (
    <div className={cn("relative", className)}>
      <div aria-hidden="true" className="absolute inset-x-2 top-0 h-3/4 rounded-md bg-overlay" />
      <div aria-hidden="true" className="absolute inset-x-1 top-1 h-3/4 rounded-md bg-strong/30" />
      <div className="absolute inset-x-0 bottom-0 top-2 overflow-hidden rounded-md bg-imaging">
        <svg viewBox="0 0 112 72" className="h-full w-full" aria-hidden="true">
          <ellipse cx="54" cy="36" rx="30" ry="20" fill="#2C2C2C" />
          <ellipse cx="64" cy="32" rx="12" ry="8" fill="#3A3A3A" />
          <rect x="70" y="26" width="12" height="6" rx="1.5" fill="rgb(var(--accent))" />
        </svg>
        <span className="absolute bottom-1 left-1 text-xs font-semibold tracking-tight text-white">
          {label}
        </span>
        {children}
      </div>
    </div>
  );
}
