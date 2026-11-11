// FlowRad Viewer — the free, public, no-sign-in DICOM viewer.
//
// Drop a folder, a ZIP, a CD or loose files and read the study in this
// browser. Nothing is uploaded, stored, or analysed: headers are parsed in Web
// Workers, pixels are decoded off disk on demand, and closing the study frees
// it. No account and no paywall to view; signing up (free) is only offered for
// what needs one — saving, sharing, teaching, the AI tutor and priors.
//
// No session or study data fetching. Metadata resolves the authenticated public
// origin; the first drop pays only for the engine chunks (prewarmed while
// the dropzone is showing). The bundle budget for this route is enforced by
// scripts/viewer-bundle-budget.mjs; the latency budgets by
// e2e/visual/free-viewer.perf.spec.ts.

import type { Metadata } from "next";
import { headers } from "next/headers";
import { trustedPublicOrigin } from "@/lib/trustedHost";
import { ViewerShell } from "@/components/viewer/ViewerShell";

export async function generateMetadata(): Promise<Metadata> {
  const origin = await trustedPublicOrigin(headers());
  return {
    title: "FlowRad Viewer · Free DICOM viewer in your browser",
    description:
      "Open a DICOM folder, ZIP or CD in your browser and read it instantly. Free, no sign-in. Your images never leave your computer. For education and research. Not for diagnostic use.",
    metadataBase: new URL(origin),
    alternates: { canonical: `${origin}/viewer` },
    openGraph: {
      url: `${origin}/viewer`,
      images: [`${origin}/opengraph-image`],
      title: "FlowRad Viewer — free DICOM viewer",
      description: "Drop a study and read it instantly. Your images never leave your computer.",
    },
    twitter: {
      card: "summary_large_image",
      title: "FlowRad Viewer — free DICOM viewer",
      description: "Open a DICOM folder, ZIP or CD. Free, no sign-in. Your images never leave your computer.",
      images: [`${origin}/opengraph-image`],
    },
    icons: { icon: "/owlscan.svg" },
  };
}

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
