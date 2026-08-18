import Link from "next/link";
import { GraduationCap, LogIn, PenLine } from "lucide-react";
import { Button } from "@/components/ui";
import { BrandMark } from "@/components/AppShell";

/**
 * Marketplace first viewport — brand, one headline, one supporting line,
 * one CTA group. Atmosphere is film black + a quiet reticle, not AI glow.
 */
export function MarketplaceHero({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="relative overflow-hidden border-b border-subtle">
      <HeroAtmosphere />
      <div className="relative mx-auto flex min-h-[32rem] max-w-6xl flex-col justify-center px-6 py-16 sm:min-h-[36rem] sm:px-8 sm:py-20">
        <p className="flex items-center gap-3">
          <BrandMark size="lg" />
          <span className="font-display text-4xl font-semibold tracking-tightest text-primary sm:text-5xl">
            FlowRad{" "}
            <span className="font-normal text-secondary">Learn</span>
          </span>
        </p>
        <h1 className="mt-8 max-w-xl font-display text-xl font-semibold leading-snug tracking-tight text-primary sm:text-2xl">
          Radiology, taught on the study.
        </h1>
        <p className="mt-3 max-w-lg text-[0.95rem] leading-relaxed text-secondary">
          Curated teachers, narrated DICOM cases, and an AI tutor — one click
          from the reading room to the marketplace.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link href="/library#courses">
            <Button
              size="lg"
              leadingIcon={<GraduationCap className="h-4 w-4" aria-hidden="true" />}
            >
              Browse courses
            </Button>
          </Link>
          <Link href="/studio">
            <Button
              size="lg"
              variant="secondary"
              leadingIcon={<PenLine className="h-4 w-4 text-accent" aria-hidden="true" />}
            >
              Start teaching
            </Button>
          </Link>
          <Link href={signedIn ? "/dashboard" : "/sign-in"}>
            <Button
              size="lg"
              variant="ghost"
              leadingIcon={<LogIn className="h-4 w-4" aria-hidden="true" />}
            >
              {signedIn ? "Your home" : "Sign in"}
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

/** Full-bleed film plane + restrained scan reticle. */
function HeroAtmosphere() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <div className="absolute inset-0 bg-imaging" />
      <div className="absolute inset-0 bg-gradient-to-r from-imaging via-imaging to-surface/80" />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-canvas to-transparent" />
      <ScanReticle />
    </div>
  );
}

function ScanReticle() {
  return (
    <svg
      className="absolute right-[6%] top-1/2 hidden h-[26rem] w-[26rem] -translate-y-1/2 text-secondary/25 md:block"
      viewBox="0 0 200 200"
      fill="none"
    >
      <circle cx="100" cy="100" r="88" stroke="currentColor" strokeWidth="0.6" />
      <circle cx="100" cy="100" r="58" stroke="currentColor" strokeWidth="0.5" opacity="0.7" />
      <circle cx="100" cy="100" r="8" stroke="currentColor" strokeWidth="1" />
      <path
        d="M100 12 v28 M100 160 v28 M12 100 h28 M160 100 h28"
        stroke="currentColor"
        strokeWidth="0.8"
      />
      <path d="M100 84 v32 M84 100 h32" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}
