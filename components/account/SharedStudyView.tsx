// What someone with a share link sees: view-only viewer + the teaching text
// the link allows. Server component (no client state of its own); used by
// /s/<token> (full page) and /embed/<token> (iframe, compact).

import Image from "next/image";
import Link from "next/link";
import { Download, Eye, Layers } from "lucide-react";
import { RemoteStudyViewer } from "./RemoteStudyViewer";
import { cn } from "@/components/ui";
import type { ResolvedShare } from "@/lib/cloud/access";
import { markupVisible, shareDicomwebRoot, visibleTeachingText } from "@/lib/cloud/shares";

export function SharedStudyView({ resolved, studyId, embed = false }: { resolved: ResolvedShare; studyId?: string; embed?: boolean }) {
  const { share, studies, collection } = resolved;
  const study = (studyId && studies.find((s) => s.id === studyId)) || studies[0];
  const base = embed ? `/embed/${share.token}` : `/s/${share.token}`;
  const text = study ? visibleTeachingText(study, share.mode) : null;
  const unknown = share.mode === "unknown";

  return (
    <div className={cn("flex min-h-dvh flex-col bg-imaging text-white", embed && "h-dvh min-h-0")}>
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 px-4 py-2">
        <Link href="/" target={embed ? "_blank" : undefined} aria-label="FlowRad Viewer" className="flex items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
          <Image src="/brand/flowrad-lockup-dark.svg" alt="FlowRad" width={92} height={26} unoptimized className="h-6 w-auto" />
          <span className="text-xs font-semibold text-white/70">Viewer</span>
        </Link>
        <span className="inline-flex items-center gap-1 rounded-full border border-white/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white/70">
          <Eye className="h-3 w-3" aria-hidden /> View only
        </span>
        {unknown && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">Unknown case</span>}
        {/* An unknown never shows the study title: it often names the diagnosis. */}
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-white">{unknown ? collection?.name ?? "" : study?.title ?? collection?.name}</h1>
        {share.allowDownload && study && (
          <a
            href={`/api/s/${share.token}/download?study=${study.id}`}
            className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-medium hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <Download className="h-3.5 w-3.5" aria-hidden /> Download DICOM
          </a>
        )}
      </header>

      {collection && studies.length > 1 && (
        <nav aria-label="Studies in this collection" className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/10 px-2 py-1.5">
          {studies.map((s, i) => (
            <Link
              key={s.id}
              href={`${base}?study=${s.id}`}
              aria-current={s.id === study?.id ? "page" : undefined}
              className={cn(
                "whitespace-nowrap rounded-md px-3 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                s.id === study?.id ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10"
              )}
            >
              {unknown ? `Case ${i + 1}` : s.title}
            </Link>
          ))}
        </nav>
      )}

      {!study ? (
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-white/70">This collection has no studies yet.</div>
      ) : (
        <div className={cn("flex min-h-0 flex-1 flex-col", !embed && "lg:flex-row")}>
          <RemoteStudyViewer
            key={study.id}
            wadoRsRoot={shareDicomwebRoot(share.token)}
            studyInstanceUID={study.studyInstanceUID}
            series={study.series}
            markup={markupVisible(share.mode) ? study.markup : undefined}
            className={cn("min-h-[55dvh] flex-1 rounded-none", embed && "min-h-0")}
          />
          {!embed && text && (
            <aside className="w-full shrink-0 space-y-5 overflow-y-auto border-t border-white/10 p-5 text-sm lg:w-96 lg:border-l lg:border-t-0" aria-label="Case notes">
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">Clinical history</h2>
                <p className="mt-1 whitespace-pre-wrap text-white/90">{text.history || "No history given."}</p>
              </section>
              {unknown ? (
                <p className="rounded-lg border border-white/10 bg-white/[0.04] p-3 text-white/70">
                  Shared as an unknown: the findings and diagnosis are hidden. Work through the images and decide for yourself.
                </p>
              ) : (
                <>
                  <section>
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">Findings</h2>
                    <p className="mt-1 whitespace-pre-wrap text-white/90">{text.findings || "—"}</p>
                  </section>
                  <section>
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">Diagnosis</h2>
                    <p className="mt-1 text-base font-semibold text-white">{text.diagnosis || "—"}</p>
                  </section>
                  {text.tags.length > 0 && (
                    <p className="flex flex-wrap gap-2 text-xs text-white/60">
                      {text.tags.map((t) => (
                        <span key={t}>#{t}</span>
                      ))}
                    </p>
                  )}
                </>
              )}
              <p className="flex items-center gap-1 text-xs text-white/45">
                <Layers className="h-3.5 w-3.5" aria-hidden /> {study.series.length} series · {study.instanceCount} images · anonymised
              </p>
              <p className="text-xs text-white/45">For education and research. Not for diagnostic use.</p>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
