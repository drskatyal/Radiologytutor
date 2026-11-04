import type { Metadata } from "next";
import Link from "next/link";
import { FolderOpen, Layers } from "lucide-react";
import { AccountShell, requirePageAccount } from "@/components/account/AccountShell";
import { UploadStudies } from "@/components/account/UploadStudies";
import { Badge, EmptyState, Input, PageContainer, SectionHeading } from "@/components/ui";
import { checkStudyQuota } from "@/lib/cloud/plans";
import { viewerStore } from "@/lib/cloud/store";

export const metadata: Metadata = { title: "Studies · FlowRad Viewer" };
export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default async function LibraryPage({ searchParams }: { searchParams: { tag?: string; q?: string } }) {
  const ctx = await requirePageAccount("/library");
  const all = await viewerStore().listStudies(ctx.user.id);
  const tag = searchParams.tag?.trim().toLowerCase() || null;
  const q = searchParams.q?.trim().toLowerCase() || null;
  const studies = all.filter(
    (s) =>
      (!tag || s.tags.includes(tag)) &&
      (!q || [s.title, s.diagnosis, s.history, ...s.tags].some((t) => t.toLowerCase().includes(q)))
  );
  const tags = [...new Set(all.flatMap((s) => s.tags))].sort();
  const quota = checkStudyQuota(ctx.account.plan, ctx.used, 0);

  return (
    <AccountShell ctx={ctx}>
      <PageContainer>
        <SectionHeading
          title={<span className="font-display text-4xl font-medium">Your studies</span>}
          description="Anonymised studies you have stored. Open one to write it up, add markup, or share it."
          aside={<UploadStudies remaining={quota.remaining} />}
        />

        {all.length > 0 && (
          <form className="mt-6 flex flex-wrap items-center gap-2" role="search">
            <label htmlFor="q" className="sr-only">
              Search studies
            </label>
            <Input id="q" name="q" type="search" defaultValue={searchParams.q ?? ""} placeholder="Search title, diagnosis, history or tag" className="max-w-sm" />
            {tag && <input type="hidden" name="tag" value={tag} />}
            {tags.map((t) => (
              <Link
                key={t}
                href={tag === t ? "/library" : `/library?tag=${encodeURIComponent(t)}`}
                aria-current={tag === t ? "true" : undefined}
                className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Badge variant={tag === t ? "accent" : "neutral"}>#{t}</Badge>
              </Link>
            ))}
          </form>
        )}

        {all.length === 0 ? (
          <EmptyState
            className="mt-8"
            icon={<FolderOpen className="h-6 w-6" aria-hidden />}
            title="No stored studies yet"
            description="Store a study to write up its history, findings and diagnosis, save your markup, and share it as a view-only link. Files are anonymised in your browser first."
            action={<UploadStudies remaining={quota.remaining} />}
          />
        ) : studies.length === 0 ? (
          <p className="mt-8 text-sm text-secondary">
            No studies match.{" "}
            <Link href="/library" className="font-semibold text-accent hover:underline">
              Clear the filter
            </Link>
          </p>
        ) : (
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="study-list">
            {studies.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/studies/${s.id}`}
                  className="group flex h-full flex-col rounded-xl border border-subtle bg-surface p-5 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <div className="flex items-center gap-2">
                    {s.modality && <Badge variant="accent">{s.modality}</Badge>}
                    {s.status === "uploading" && <Badge variant="warning">Upload incomplete</Badge>}
                    <span className="ml-auto text-xs tabular-nums text-muted">{dateFmt.format(new Date(s.createdAt))}</span>
                  </div>
                  <h3 className="mt-3 text-lg font-semibold leading-snug group-hover:text-accent">{s.title}</h3>
                  {s.diagnosis ? (
                    <p className="mt-1 line-clamp-2 text-sm text-secondary">{s.diagnosis}</p>
                  ) : (
                    <p className="mt-1 text-sm text-muted">No diagnosis yet</p>
                  )}
                  <div className="mt-auto flex flex-wrap items-center gap-2 pt-4 text-xs text-muted">
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      <Layers className="h-3.5 w-3.5" aria-hidden />
                      {s.series.length} series · {s.instanceCount} images
                    </span>
                    {s.tags.slice(0, 3).map((t) => (
                      <span key={t}>#{t}</span>
                    ))}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageContainer>
    </AccountShell>
  );
}
