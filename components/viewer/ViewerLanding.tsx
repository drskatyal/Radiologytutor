"use client";

// The free viewer's landing (/viewer, before a study is on screen): FlowRad
// brand, one big friendly drop target for a folder, ZIP or CD, the privacy
// promise, and a small bundled sample for anyone without a study to hand.
//
// Presentational only. LocalStudyViewer owns the inputs, the drop pipeline and
// the reading state, and passes them in. No images, fonts or scripts of its
// own: the art is inline SVG and the theme is CSS variables (`.viewer-shell`
// in app/globals.css), so first load pays nothing extra.

import {
  AlertTriangle,
  ArrowDownToLine,
  FileSearch,
  Gauge,
  Gift,
  Lock,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { Button, Spinner } from "@/components/ui";
import { cn } from "@/components/ui/cn";

export type LandingStatus =
  | { kind: "idle" }
  | { kind: "reading"; progress: React.ReactNode }
  | { kind: "empty"; description: string }
  | { kind: "error"; description: string }
  | { kind: "restored"; description: string };

export interface ViewerLandingProps {
  status: LandingStatus;
  dragging: boolean;
  onDragOver: (event: React.DragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
  /** Choose a folder / Choose files (and Reopen after an update). */
  actions: React.ReactNode;
  onCancel: () => void;
  /** Open the bundled, de-identified sample study. Absent: no sample offered. */
  onSample?: () => void;
  sampleState?: "idle" | "loading" | "error";
  /** Recent studies (Chromium: reopenable from a kept folder handle). */
  recent?: React.ReactNode;
}

const FORMATS = ["Study folder", "ZIP", "CD / DICOMDIR", "Loose .dcm files"];

const POINTS = [
  {
    icon: Lock,
    title: "Private by design",
    body: "Read in this tab, straight from your disk. Close it and the study is gone.",
  },
  {
    icon: Gauge,
    title: "Built for reading",
    body: "The first image shows while the rest loads. Scroll, window, zoom and measure.",
  },
  {
    icon: Gift,
    title: "Free, no account",
    body: "Viewing is free. An account is only for saving, sharing and teaching.",
  },
];

export function ViewerLanding({
  status,
  dragging,
  onDragOver,
  onDragLeave,
  onDrop,
  actions,
  onCancel,
  onSample,
  sampleState = "idle",
  recent,
}: ViewerLandingProps) {
  const idle = status.kind === "idle";
  const problem = status.kind === "empty" || status.kind === "error";

  const title = dragging
    ? "Release to open the study"
    : status.kind === "empty"
      ? "No DICOM images in that selection"
      : status.kind === "error"
        ? "That study could not be read"
        : status.kind === "restored"
          ? "The viewer was updated"
          : "Drop a study folder, ZIP or CD here";

  const description =
    status.kind === "idle" || status.kind === "reading"
      ? "Or choose one from this computer. Every series is listed as soon as it is read."
      : status.description;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 sm:gap-10">
      {idle && (
        <section className="flex flex-col items-center gap-3 text-center">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-vl-brand/25 bg-vl-brand-soft px-3 py-1 text-xs font-semibold text-vl-brand">
            <Reticle className="h-3.5 w-3.5" />
            Free DICOM viewer · no sign-in
          </p>
          <h1 className="max-w-2xl text-balance text-3xl font-semibold tracking-tightest text-vl-fg sm:text-[2.6rem] sm:leading-[1.1]">
            Open a study. Read it right here.
          </h1>
          <p className="max-w-xl text-pretty text-sm text-vl-muted sm:text-base">
            CT, MR, X-ray and more from a folder, a ZIP or a study CD, in your browser. Nothing to
            install and nothing uploaded.
          </p>
        </section>
      )}

      <div
        data-testid="local-dropzone"
        role="region"
        aria-label="Drop a study folder, ZIP or files here"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "relative flex flex-col items-center rounded-3xl border-2 border-dashed px-5 py-10 text-center transition-[border-color,background-color,transform] duration-200 ease-draw sm:px-10 sm:py-14",
          dragging
            ? "scale-[1.01] border-vl-brand bg-vl-brand-soft"
            : "border-vl-border bg-vl-surface"
        )}
      >
        {status.kind === "reading" ? (
          <div className="flex flex-col items-center gap-4 py-4" aria-live="polite">
            <Spinner label="Reading study" />
            {status.progress}
            <Button size="sm" variant="ghost" onClick={onCancel} className="text-vl-muted hover:bg-vl-brand-soft hover:text-vl-fg">
              Cancel
            </Button>
          </div>
        ) : (
          <>
            <DropArt state={dragging ? "drag" : problem ? (status.kind === "error" ? "error" : "empty") : status.kind === "restored" ? "restored" : "idle"} />
            <h2 className="mt-5 text-balance text-lg font-semibold tracking-tight text-vl-fg sm:text-xl">{title}</h2>
            <p className="mt-2 max-w-md text-pretty text-sm text-vl-muted">{description}</p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{actions}</div>
            <ul className="mt-6 flex flex-wrap justify-center gap-1.5" aria-label="What you can open">
              {FORMATS.map((format) => (
                <li
                  key={format}
                  className="rounded-full border border-vl-border px-2.5 py-0.5 text-[11px] font-medium text-vl-muted"
                >
                  {format}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-6 max-w-sm text-balance text-center text-xs text-vl-muted">
          <ShieldCheck className="mr-1.5 inline h-3.5 w-3.5 -translate-y-px text-vl-brand" aria-hidden />
          Files stay in this browser. Nothing is uploaded or copied.
        </p>
      </div>

      {onSample && status.kind !== "reading" && (
        <div className="-mt-3 flex flex-col items-center gap-1 text-sm text-vl-muted sm:-mt-4">
          <p className="flex flex-wrap items-center justify-center gap-x-1.5">
            No study to hand?
            <button
              type="button"
              onClick={onSample}
              disabled={sampleState === "loading"}
              className="inline-flex items-center gap-1.5 rounded-md px-1 font-semibold text-vl-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vl-brand disabled:cursor-wait disabled:opacity-70"
            >
              {sampleState === "loading" && <Spinner size="sm" label="Loading the sample" />}
              {sampleState === "loading" ? "Opening the sample MR…" : "Open a sample MR"}
            </button>
          </p>
          {sampleState === "error" && (
            <p role="alert" className="text-xs text-danger">
              The sample could not be loaded. Check your connection and try again.
            </p>
          )}
        </div>
      )}

      {status.kind !== "reading" && recent}

      {idle && (
        <ul className="grid gap-3 sm:grid-cols-3">
          {POINTS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="rounded-2xl border border-vl-border bg-vl-surface/60 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-vl-fg">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-vl-brand-soft text-vl-brand">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                {title}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-vl-muted">{body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The Owl Scan eye: a CT-gantry ring with reticle ticks (brand/brand.md). */
function Reticle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" strokeLinecap="round" />
    </svg>
  );
}

/** Drop target art: the gantry ring around what the zone is asking for. */
function DropArt({ state }: { state: "idle" | "drag" | "empty" | "error" | "restored" }) {
  const Icon = state === "error" ? AlertTriangle : state === "empty" ? FileSearch : state === "restored" ? RotateCcw : ArrowDownToLine;
  const warn = state === "error" || state === "empty";
  return (
    <div className={cn("relative flex h-20 w-20 items-center justify-center", warn ? "text-warning" : "text-vl-brand")}>
      <svg viewBox="0 0 80 80" fill="none" className="absolute inset-0 h-full w-full" aria-hidden>
        <circle cx="40" cy="40" r="38" className={warn ? "fill-warning/10" : "fill-vl-brand-soft"} />
        <circle
          cx="40"
          cy="40"
          r="28"
          stroke="currentColor"
          strokeOpacity={0.45}
          strokeWidth={2}
          strokeDasharray={state === "drag" ? "4 4" : undefined}
          className={cn(state === "drag" && "origin-center animate-[spin_6s_linear_infinite] motion-reduce:animate-none")}
        />
        <path d="M40 6v8M40 66v8M6 40h8M66 40h8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      </svg>
      <Icon className={cn("relative h-7 w-7", state === "drag" && "motion-safe:animate-bounce")} aria-hidden />
    </div>
  );
}
