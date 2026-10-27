import { cn } from "@/components/ui/cn";

/**
 * Small product drawings: slice stack, attending voice, a published frame,
 * and a prior beside the current study. No reticle.
 */
export function TeachMotif({
  kind,
  className,
}: {
  kind: "stack" | "voice" | "publish" | "compare";
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("h-6 w-6", className)}
      fill="none"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      {kind === "stack" && (
        <>
          <rect x="8" y="5" width="14" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
          <rect x="6" y="9" width="14" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" opacity="0.7" />
          <rect x="4" y="13" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M9 19h8M9 22h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
      {kind === "voice" && (
        <>
          <rect x="4" y="8" width="24" height="16" rx="4" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 18v-2M14 20v-6M18 19v-4M22 20v-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
      {kind === "publish" && (
        <>
          <rect x="6" y="5" width="20" height="22" rx="3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 16.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {kind === "compare" && (
        <>
          <rect x="3" y="8" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
          <rect x="15" y="8" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M19 16h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
