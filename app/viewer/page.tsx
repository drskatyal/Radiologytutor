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

import type { Metadata } from "next";
import { ViewerShell } from "@/components/viewer/ViewerShell";

export const metadata: Metadata = {
  title: "FlowRad Viewer · Free DICOM viewer in your browser",
  description:
    "Open a DICOM folder, ZIP or CD in your browser and read it instantly. Free, no sign-in. Your images never leave your computer. For education and research. Not for diagnostic use.",
  alternates: { canonical: "https://app.viewer.flowrad.ai/viewer" },
  openGraph: {
    url: "https://app.viewer.flowrad.ai/viewer",
    images: ["https://app.viewer.flowrad.ai/opengraph-image"],
    title: "FlowRad Viewer — free DICOM viewer",
    description: "Drop a study and read it instantly. Your images never leave your computer.",
  },
  twitter: {
    card: "summary_large_image",
    title: "FlowRad Viewer — free DICOM viewer",
    description: "Open a DICOM folder, ZIP or CD. Free, no sign-in. Your images never leave your computer.",
    images: ["https://app.viewer.flowrad.ai/opengraph-image"],
  },
  icons: { icon: "/owlscan.svg" },
};

export default function FreeViewerPage() {
  return (
    <ViewerShell
      home={{ href: "/viewer", label: "FlowRad Viewer" }}
      product="Viewer"
      badge="Free"
      source={{ kind: "local" }}
    />
  );
}
