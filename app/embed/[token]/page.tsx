// Chrome-less share viewer for <iframe> embeds. The only route that may be
// framed by other sites (next.config.mjs headers). Reads pixels through the
// token-in-path DICOMweb root, so it needs no third-party cookie.

import type { Metadata } from "next";
import { SharedStudyView } from "@/components/account/SharedStudyView";
import { resolveShare } from "@/lib/cloud/access";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "FlowRad Viewer",
  robots: { index: false, follow: false },
};

export default async function EmbedPage({ params, searchParams }: { params: { token: string }; searchParams: { study?: string } }) {
  const resolved = await resolveShare(params.token);
  if (!resolved) {
    return (
      <main className="flex h-dvh items-center justify-center bg-imaging p-6 text-center text-sm text-white/70">
        This shared study has expired or was removed by its owner.
      </main>
    );
  }
  return <SharedStudyView resolved={resolved} studyId={searchParams.study} embed />;
}
