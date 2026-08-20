"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { GraduationCap, LogIn, PenLine } from "lucide-react";
import { Button } from "@/components/ui";
import { BrandMark, Wordmark } from "@/components/brand/BrandMark";

/**
 * Marketplace first viewport — brand as the hero signal.
 * One headline, one line, one CTA group, full-bleed film plane.
 */
export function MarketplaceHero({ signedIn }: { signedIn: boolean }) {
  const reduce = useReducedMotion();

  return (
    <section className="relative overflow-hidden border-b border-subtle">
      <HeroAtmosphere reduce={Boolean(reduce)} />
      <div className="relative mx-auto flex min-h-[28rem] max-w-6xl flex-col justify-center px-6 py-16 sm:min-h-[34rem] sm:px-8 sm:py-20">
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-4 sm:gap-5">
            <BrandMark size="hero" />
            <Wordmark size="hero" />
          </div>

          <div className="max-w-xl space-y-3">
            <h1 className="font-display text-xl font-semibold leading-snug tracking-tight text-primary sm:text-2xl md:text-[1.65rem]">
              Radiology, taught on the study.
            </h1>
            <p className="max-w-md text-[0.95rem] leading-relaxed text-secondary">
              Narrated DICOM cases from verified teachers — scroll the stack,
              learn the finding, ask the tutor.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Link href="/library#cases">
              <Button
                size="lg"
                leadingIcon={<GraduationCap className="h-4 w-4" aria-hidden="true" />}
              >
                Enter the library
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
      </div>
    </section>
  );
}

function HeroAtmosphere({ reduce }: { reduce: boolean }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <div className="absolute inset-0 bg-imaging" />
      {/* Soft windowing wash — restrained, not a central glow blob */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: [
            "linear-gradient(105deg, rgb(0 0 0) 0%, rgb(0 0 0) 48%, rgb(18 17 15 / 0.9) 72%, rgb(22 21 19 / 0.75) 100%)",
            "radial-gradient(ellipse 45% 50% at 78% 42%, rgb(55 58 62 / 0.28), transparent 70%)",
          ].join(", "),
        }}
      />
      {/* Film grain */}
      <div
        className="absolute inset-0 opacity-[0.035] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
      <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-canvas to-transparent" />
      <ScanReticle animate={!reduce} />
    </div>
  );
}

function ScanReticle({ animate }: { animate: boolean }) {
  return (
    <motion.svg
      className="absolute right-[4%] top-[42%] hidden h-[min(28rem,55vh)] w-[min(28rem,55vh)] -translate-y-1/2 text-secondary/30 md:block"
      viewBox="0 0 200 200"
      fill="none"
      initial={animate ? { opacity: 0, scale: 0.96 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
    >
      <circle cx="100" cy="100" r="88" stroke="currentColor" strokeWidth="0.55" />
      <circle cx="100" cy="100" r="58" stroke="currentColor" strokeWidth="0.45" opacity="0.75" />
      <circle cx="100" cy="100" r="7" stroke="currentColor" strokeWidth="1" />
      <path
        d="M100 12 v26 M100 162 v26 M12 100 h26 M162 100 h26"
        stroke="currentColor"
        strokeWidth="0.75"
      />
      <path d="M100 82 v36 M82 100 h36" stroke="currentColor" strokeWidth="1" />
      {animate && (
        <motion.line
          x1="22"
          y1="100"
          x2="178"
          y2="100"
          stroke="rgb(var(--accent))"
          strokeWidth="0.5"
          opacity="0.35"
          animate={{ y1: [40, 160, 40], y2: [40, 160, 40] }}
          transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
        />
      )}
    </motion.svg>
  );
}
