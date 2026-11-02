// FlowRad Viewer — the free, public, no-sign-in DICOM viewer.
//
// Drop a folder, a ZIP, a CD or loose files and read the study in this
// browser. Nothing is uploaded, stored, or analysed: headers are parsed in Web
// Workers, pixels are decoded off disk on demand, and closing the study frees
// it. No account and no paywall to view; signing up (free) is only offered for
// what needs one — saving, sharing, teaching, the AI tutor and priors.
//
// Static on purpose: no session, no data fetching, so the shell is served from
// cache and the first drop pays only for the engine chunks (prewarmed while
// the dropzone is showing). The bundle budget for this route is enforced by
// scripts/viewer-bundle-budget.mjs; the latency budgets by
// e2e/visual/free-viewer.perf.spec.ts.

import Image from "next/image";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { LocalStudyViewer } from "@/components/viewer/LocalStudyViewer";
import { ViewerPrewarm } from "@/components/viewer/ViewerPrewarm";

export const metadata = {
  title: "FlowRad Viewer · Free DICOM viewer in your browser",
  description:
    "Open a DICOM folder, ZIP or CD in your browser and read it instantly. Free, no sign-in. Your images never leave your computer.",
  openGraph: {
    title: "FlowRad Viewer — free DICOM viewer",
    description: "Drop a study and read it instantly. Your images never leave your computer.",
  },
  icons: { icon: "/owlscan.svg" },
};

export default function FreeViewerPage() {
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-imaging text-white">
      {/* The engine chunks warm while the user is choosing a folder. */}
      <ViewerPrewarm />
      <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-2 sm:gap-3">
        <Link
          href="/viewer"
          aria-label="FlowRad Viewer"
          className="flex items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          {/* The approved Owl Scan lockup, byte for byte (brand/brand.md). */}
          <Image
            src="/brand/flowrad-lockup-dark.svg"
            alt="FlowRad"
            width={113}
            height={32}
            priority
            unoptimized
            className="h-8 w-auto"
          />
          <span className="text-sm font-semibold tracking-tight text-white/80">Viewer</span>
        </Link>
        <span className="ml-1 hidden rounded-full border border-white/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white/60 sm:inline">
          Free
        </span>
        <p className="ml-auto flex min-w-0 items-center gap-1.5 pl-3 text-right text-[11px] leading-tight text-white/70 sm:text-xs">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
          <span>Your images never leave your computer.</span>
        </p>
      </header>
      <main className="flex min-h-0 flex-1 flex-col" aria-label="DICOM viewer">
        <div className="flex min-h-0 flex-1 flex-col px-4 py-4 has-[[data-testid=local-stage]]:p-0">
          <LocalStudyViewer tone="reading" />
        </div>
      </main>
    </div>
  );
}
