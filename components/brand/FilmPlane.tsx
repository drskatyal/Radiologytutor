import { cn } from "@/components/ui/cn";

/**
 * Imaging-led visual for catalog rows — film black plane with modality
 * windowing wash. Not a card; the visual anchor for case lists.
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
    <div
      className={cn(
        "relative overflow-hidden bg-imaging",
        "ring-1 ring-inset ring-white/5",
        className
      )}
    >
      {/* Windowing gradient — CT/MR reading-room atmosphere */}
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-90"
        style={{
          backgroundImage: [
            "radial-gradient(ellipse 80% 60% at 35% 40%, rgb(90 95 100 / 0.35), transparent 60%)",
            "radial-gradient(ellipse 50% 40% at 70% 65%, rgb(var(--accent) / 0.08), transparent 55%)",
            "linear-gradient(180deg, rgb(18 18 18) 0%, rgb(0 0 0) 100%)",
          ].join(", "),
        }}
      />
      {/* Faint scan grid */}
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(rgb(255 255 255 / 0.5) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 0.5) 1px, transparent 1px)",
          backgroundSize: "12px 12px",
        }}
      />
      {/* Reticle */}
      <svg
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 text-secondary/40"
        viewBox="0 0 40 40"
        fill="none"
      >
        <circle cx="20" cy="20" r="14" stroke="currentColor" strokeWidth="0.8" />
        <path d="M20 4v6M20 30v6M4 20h6M30 20h6" stroke="currentColor" strokeWidth="0.9" />
        <circle cx="20" cy="20" r="2.5" stroke="currentColor" strokeWidth="1" />
      </svg>
      <span className="absolute bottom-1.5 left-2 font-mono text-[10px] font-medium tracking-wider text-secondary/70">
        {label}
      </span>
      {children}
    </div>
  );
}
