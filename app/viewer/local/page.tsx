// The free reader inside FlowRad Learn: open a study from this computer.
//
// Same reading room as the public FlowRad Viewer (/viewer, ViewerShell):
// the image fills the window, the series panel and toolbar sit at its edges,
// and every reading tool is there. Nothing is uploaded. AppShell gives this
// route the full window (no app nav), so the bar links back to Learn.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ViewerShell } from "@/components/viewer/ViewerShell";

export const metadata = {
  title: "Open a local study · FlowRad Learn",
  description:
    "Read a DICOM study from your own computer. Scroll, window, measure and reconstruct three planes. Nothing is uploaded.",
};

export default function LocalViewerPage() {
  return (
    <ViewerShell
      home={{ href: "/", label: "FlowRad Learn home" }}
      product="Learn"
      actions={
        <Link
          href="/"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-vl-muted transition-colors hover:text-vl-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vl-brand"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Back to Learn
        </Link>
      }
    />
  );
}
