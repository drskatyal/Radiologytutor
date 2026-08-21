import Link from "next/link";
import { notFound } from "next/navigation";
import { Layers, ListMusic, PlayCircle } from "lucide-react";
import { getPlaylist, getCasesByIds } from "@/lib/cases";
import { activeOrgId } from "@/lib/auth";
import { Badge, Breadcrumbs, Button, EmptyState, PageContainer } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { CourseCases } from "@/components/catalog/CourseCases";

export const dynamic = "force-dynamic";

export default async function PlaylistPage({ params }: { params: { id: string } }) {
  const orgId = await activeOrgId();
  const playlist = await getPlaylist(orgId, params.id);
  if (!playlist) notFound();

  const cases = await getCasesByIds(orgId, playlist.caseIds);
  const firstCaseId = cases[0]?.caseId;

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Library", href: "/library" }, { label: "Playlist" }]} />}
        title={
          <span className="inline-flex items-center gap-2.5">
            <ListMusic className="h-5 w-5 text-accent" aria-hidden="true" />
            {playlist.title}
          </span>
        }
        description={playlist.description}
        actions={
          firstCaseId && (
            <Link href={`/case/${firstCaseId}`}>
              <Button leadingIcon={<PlayCircle className="h-4 w-4" aria-hidden="true" />}>
                Play all
              </Button>
            </Link>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="neutral" className="gap-1.5 tabular-nums">
            <Layers className="h-3 w-3" aria-hidden="true" />
            {cases.length} case{cases.length === 1 ? "" : "s"}
          </Badge>
        </div>
      </PageHeader>

      <PageContainer>
        {cases.length === 0 ? (
          <EmptyState
            icon={<ListMusic aria-hidden="true" />}
            title="This playlist is empty"
            description="An admin can add and order cases for this playlist from the Admin console."
            action={
              <Link href="/library">
                <Button variant="secondary">Back to library</Button>
              </Link>
            }
          />
        ) : (
          <CourseCases cases={cases} />
        )}
      </PageContainer>
    </>
  );
}
