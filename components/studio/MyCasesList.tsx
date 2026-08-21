"use client";

// Studio / My cases — the default Studio tab. A grid of the author's own
// cases (drafts + published) with the actions that matter at each stage:
// edit findings, continue recording (drafts), preview as a student, and
// publish/unpublish. Folds the old admin "Cases" list into the teaching home.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CircleAlert, Mic, Pencil, Play, Plus, Stethoscope, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Modal,
  PageContainer,
  Skeleton,
  Tabs,
  useToast,
} from "@/components/ui";
import { StudioHeader } from "./StudioHeader";
import { deleteCase as apiDeleteCase, fetchCases, updateCase as apiUpdateCase } from "@/components/admin/api";
import type { AdminCaseRow, CaseStatus } from "@/components/admin/types";

type Filter = "all" | CaseStatus;

export function MyCasesList() {
  const { toast } = useToast();
  const [cases, setCases] = useState<AdminCaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminCaseRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const cs = await fetchCases();
      setCases(cs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(
    () => ({
      all: cases.length,
      draft: cases.filter((c) => c.status === "draft").length,
      published: cases.filter((c) => c.status === "published").length,
    }),
    [cases]
  );

  const visible = useMemo(
    () => (filter === "all" ? cases : cases.filter((c) => c.status === filter)),
    [cases, filter]
  );

  async function togglePublish(c: AdminCaseRow) {
    const next: CaseStatus = c.status === "published" ? "draft" : "published";
    setBusyId(c.caseId);
    setCases((prev) => prev.map((x) => (x.caseId === c.caseId ? { ...x, status: next } : x)));
    try {
      await apiUpdateCase(c.caseId, { status: next });
      toast({
        variant: "success",
        title: next === "published" ? "Case published" : "Case unpublished",
        description: next === "published" ? "Students can now see this case." : "This case is hidden from students.",
      });
    } catch (e) {
      setCases((prev) => prev.map((x) => (x.caseId === c.caseId ? { ...x, status: c.status } : x)));
      toast({ variant: "danger", title: "Could not update status", description: (e as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setDeleting(true);
    try {
      await apiDeleteCase(target.caseId);
      setCases((prev) => prev.filter((c) => c.caseId !== target.caseId));
      toast({ variant: "success", title: "Case deleted", description: `"${target.title}" removed.` });
      setPendingDelete(null);
    } catch (e) {
      toast({ variant: "danger", title: "Could not delete case", description: (e as Error).message });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="animate-fade-in">
      <StudioHeader active="cases" />
      <PageContainer>
        {loading ? (
          <LoadingGrid />
        ) : error ? (
          <EmptyState
            icon={<CircleAlert aria-hidden="true" />}
            title="Couldn't load your cases"
            description={error}
            action={
              <Button variant="secondary" onClick={load}>
                Retry
              </Button>
            }
          />
        ) : cases.length === 0 ? (
          <EmptyState
            icon={<Stethoscope aria-hidden="true" />}
            title="No cases yet — teach your first study"
            description="Upload a DICOM study, mark the findings, and record your read."
            action={
              <Link href="/studio/new">
                <Button leadingIcon={<Plus className="h-4 w-4" aria-hidden="true" />}>Create a case</Button>
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-5">
            <Tabs
              value={filter}
              onValueChange={(v) => setFilter(v as Filter)}
              items={[
                { value: "all", label: "All", count: counts.all },
                { value: "published", label: "Published", count: counts.published },
                { value: "draft", label: "Drafts", count: counts.draft },
              ]}
            />
            {visible.length === 0 ? (
              <EmptyState title={`No ${filter} cases`} description="Try a different filter." />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visible.map((c) => (
                  <CaseTile
                    key={c.caseId}
                    c={c}
                    busy={busyId === c.caseId}
                    onPublishToggle={() => togglePublish(c)}
                    onDelete={() => setPendingDelete(c)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </PageContainer>

      <Modal
        open={pendingDelete != null}
        onClose={() => !deleting && setPendingDelete(null)}
        title="Delete case?"
        description={
          pendingDelete
            ? `"${pendingDelete.title}" and its findings will be permanently removed. The underlying study stays in the imaging archive.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} loading={deleting}>
              Delete case
            </Button>
          </>
        }
      />
    </div>
  );
}

function CaseTile({
  c,
  busy,
  onPublishToggle,
  onDelete,
}: {
  c: AdminCaseRow;
  busy: boolean;
  onPublishToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="flex h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold text-primary">{c.title}</h3>
        <Badge variant={c.status === "published" ? "success" : "warning"}>{c.status}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="neutral">{c.modality}</Badge>
        <Badge variant={c.findingCount > 0 ? "accent" : "neutral"}>
          {c.findingCount} finding{c.findingCount === 1 ? "" : "s"}
        </Badge>
      </div>
      <p className="truncate text-xs text-muted">{c.caseId}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
        <Link href={`/studio/cases/${encodeURIComponent(c.caseId)}`}>
          <Button size="sm" variant="secondary" leadingIcon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}>
            Edit
          </Button>
        </Link>
        {c.status === "draft" && (
          <Link href={`/studio/cases/${encodeURIComponent(c.caseId)}/record`}>
            <Button size="sm" variant="secondary" leadingIcon={<Mic className="h-3.5 w-3.5" aria-hidden="true" />}>
              Continue recording
            </Button>
          </Link>
        )}
        <Link href={`/case/${encodeURIComponent(c.caseId)}`}>
          <Button size="sm" variant="ghost" leadingIcon={<Play className="h-3.5 w-3.5" aria-hidden="true" />}>
            Preview
          </Button>
        </Link>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onPublishToggle} loading={busy} disabled={busy}>
          {c.status === "published" ? "Unpublish" : "Publish"}
        </Button>
        <IconButton
          aria-label={`Delete ${c.title}`}
          size="sm"
          variant="danger"
          onClick={onDelete}
          disabled={busy}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      </div>
    </Card>
  );
}

function LoadingGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-16 rounded-md" />
          </div>
          <Skeleton className="h-5 w-24 rounded-md" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-8 w-full" />
        </Card>
      ))}
    </div>
  );
}
