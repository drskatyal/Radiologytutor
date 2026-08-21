"use client";

// Studio case editor — review each finding's structured output, fix text,
// reorder, re-run Gemini structuring, delete. Ported from the old /author
// workspace almost verbatim (CLAUDE.md: don't change the finding-editing
// mechanics, just where it lives). Adds: breadcrumbs back into Studio, a
// "Continue recording" link, a publish toggle, and an "Edit details" modal
// for the exam-grade case metadata.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, Pencil, Play, Send, Check } from "lucide-react";
import { Breadcrumbs } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import {
  Button,
  Badge,
  EmptyState,
  Modal,
  PageContainer,
  Skeleton,
  useToast,
} from "@/components/ui";
import type { CaseData, Finding } from "@/lib/types";
import { FindingsList } from "@/components/author/FindingsList";
import { AddFindingDialog } from "@/components/author/AddFindingDialog";
import { RecordFindingDialog } from "@/components/author/RecordFindingDialog";
import { useUnsavedGuard } from "@/components/author/useUnsavedGuard";
import { EditCaseModal } from "@/components/admin/EditCaseModal";
import { fetchAuthors, updateCase as apiUpdateCase } from "@/components/admin/api";
import type { Author } from "@/components/admin/types";
import {
  addFinding,
  deleteFinding,
  fetchCase,
  patchFinding,
  reorderFindings,
} from "@/components/author/lib";
import { InfoIcon, LayersIcon, PlusIcon } from "@/components/author/icons";

export function CaseEditor({ caseId }: { caseId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [caseData, setCaseData] = useState<CaseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showRecord, setShowRecord] = useState(false);
  const [showEditDetails, setShowEditDetails] = useState(false);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<Finding | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [undo, setUndo] = useState<{ finding: Finding } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    []
  );

  const [dirtyIds, setDirtyIds] = useState<Set<string>>(() => new Set());
  const hasUnsaved = dirtyIds.size > 0;
  const { confirmDiscard } = useUnsavedGuard(hasUnsaved);

  const onDirtyChange = useCallback((findingId: string, dirty: boolean) => {
    setDirtyIds((prev) => {
      const has = prev.has(findingId);
      if (dirty === has) return prev;
      const next = new Set(prev);
      if (dirty) next.add(findingId);
      else next.delete(findingId);
      return next;
    });
  }, []);

  function leaveTo(path: string) {
    if (!confirmDiscard()) return;
    router.push(path);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchCase(caseId);
      setCaseData(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load case");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetchAuthors()
      .then(setAuthors)
      .catch(() => {
        /* non-fatal — the details modal degrades to no author picker */
      });
  }, []);

  const findings = useMemo(
    () => (caseData ? [...caseData.findings].sort((a, b) => a.order - b.order) : []),
    [caseData]
  );

  // --- mutations (optimistic + toast + rollback) --------------------------

  async function saveFinding(findingId: string, patch: Partial<Finding>) {
    if (!caseData) return;
    const snapshot = caseData;
    setCaseData({
      ...caseData,
      findings: caseData.findings.map((f) => (f.id === findingId ? { ...f, ...patch } : f)),
    });
    try {
      const updated = await patchFinding(caseId, findingId, patch);
      setCaseData(updated);
      onDirtyChange(findingId, false);
      toast({ variant: "success", title: "Finding saved" });
    } catch (e) {
      setCaseData(snapshot);
      toast({
        variant: "danger",
        title: "Couldn't save — your edits are kept",
        description:
          (e instanceof Error ? e.message : "Something went wrong.") + " Press Save again to retry.",
      });
      throw e;
    }
  }

  async function confirmDelete() {
    if (!caseData || !deleteTarget) return;
    const snapshot = caseData;
    const target = deleteTarget;
    setDeleting(true);
    setCaseData({ ...caseData, findings: caseData.findings.filter((f) => f.id !== target.id) });
    try {
      const updated = await deleteFinding(caseId, target.id);
      setCaseData(updated);
      setDeleteTarget(null);
      setUndo({ finding: target });
      if (undoTimer.current) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setUndo(null), 8000);
      toast({ variant: "success", title: "Finding deleted" });
    } catch (e) {
      setCaseData(snapshot);
      toast({
        variant: "danger",
        title: "Couldn't delete finding",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setDeleting(false);
    }
  }

  async function undoDelete() {
    if (!undo) return;
    const { finding } = undo;
    setUndo(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    try {
      const updated = await addFinding(caseId, finding);
      setCaseData(updated);
      toast({ variant: "success", title: "Finding restored" });
    } catch (e) {
      toast({
        variant: "danger",
        title: "Couldn't restore finding",
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }

  async function move(findingId: string, dir: -1 | 1) {
    const ids = findings.map((f) => f.id);
    const i = ids.indexOf(findingId);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await applyReorder(ids);
  }

  async function applyReorder(orderedIds: string[]) {
    if (!caseData) return;
    const snapshot = caseData;
    const rank = new Map(orderedIds.map((id, idx) => [id, idx + 1]));
    setCaseData({
      ...caseData,
      findings: caseData.findings
        .map((f) => ({ ...f, order: rank.get(f.id) ?? f.order }))
        .sort((a, b) => a.order - b.order),
    });
    try {
      const updated = await reorderFindings(caseId, orderedIds);
      setCaseData(updated);
    } catch (e) {
      setCaseData(snapshot);
      toast({
        variant: "danger",
        title: "Couldn't reorder findings",
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }

  async function createFinding(finding: Partial<Finding>) {
    try {
      const updated = await addFinding(caseId, finding);
      setCaseData(updated);
      toast({ variant: "success", title: "Finding added" });
    } catch (e) {
      toast({
        variant: "danger",
        title: "Couldn't add finding",
        description: e instanceof Error ? e.message : undefined,
      });
      throw e;
    }
  }

  async function togglePublish() {
    if (!caseData || publishing) return;
    const next = caseData.status === "published" ? "draft" : "published";
    setPublishing(true);
    try {
      const updated = await apiUpdateCase(caseData.caseId, { status: next });
      setCaseData((c) => (c ? { ...c, status: updated.status } : c));
      toast({
        variant: "success",
        title: next === "published" ? "Case published" : "Case unpublished",
        description: next === "published" ? "Students can now see this case." : "This case is hidden from students.",
      });
    } catch (e) {
      toast({ variant: "danger", title: "Couldn't update status", description: e instanceof Error ? e.message : undefined });
    } finally {
      setPublishing(false);
    }
  }

  // --- render -------------------------------------------------------------

  const breadcrumbItems = [
    { label: "Studio", href: "/studio/cases" },
    { label: caseData?.title ?? "Case" },
  ];

  const openPreview = () => leaveTo(`/case/${caseData?.caseId ?? ""}`);

  if (loading) return <WorkspaceSkeleton />;

  if (error || !caseData) {
    return (
      <div className="animate-fade-in">
        <PageHeader
          breadcrumbs={<Breadcrumbs items={[{ label: "Studio", href: "/studio/cases" }, { label: "Case" }]} />}
          title="Studio"
        />
        <PageContainer width="narrow">
          <EmptyState
            title="Couldn't open this case"
            description={error || "The case may have been removed."}
            action={
              <div className="flex items-center justify-center gap-2">
                <Button variant="secondary" onClick={load}>
                  Try again
                </Button>
                <Button variant="ghost" onClick={() => router.push("/studio/cases")}>
                  Back to cases
                </Button>
              </div>
            }
          />
        </PageContainer>
      </div>
    );
  }

  const published = caseData.status === "published";

  return (
    <div className="animate-fade-in">
      <PageHeader
        breadcrumbs={<Breadcrumbs items={breadcrumbItems} />}
        title={caseData.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{caseData.modality}</Badge>
            <Badge variant={published ? "success" : "warning"}>{caseData.status}</Badge>
            {caseData.specialty && <Badge variant="neutral">{caseData.specialty}</Badge>}
            {hasUnsaved && (
              <Badge variant="warning" dot title="You have unsaved edits">
                Unsaved edits
              </Badge>
            )}
            <span className="text-xs text-muted">·</span>
            <span className="text-xs text-muted">{caseData.caseId}</span>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" leadingIcon={<Pencil className="h-4 w-4" />} onClick={() => setShowEditDetails(true)}>
              Edit details
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<Mic className="h-4 w-4" />}
              onClick={() => leaveTo(`/studio/cases/${encodeURIComponent(caseData.caseId)}/record`)}
            >
              Continue recording
            </Button>
            {findings.length > 0 && (
              <Button variant="ghost" size="sm" leadingIcon={<Play className="h-4 w-4" />} onClick={openPreview}>
                Preview as student
              </Button>
            )}
            <Button
              size="sm"
              leadingIcon={published ? <Check className="h-4 w-4" /> : <Send className="h-4 w-4" />}
              onClick={togglePublish}
              loading={publishing}
            >
              {published ? "Published" : "Publish"}
            </Button>
          </div>
        }
      />

      <PageContainer width="narrow">
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-subtle bg-surface px-4 py-3 text-sm text-secondary [&_svg]:h-4 [&_svg]:w-4">
          <span className="mt-0.5 shrink-0 text-info">
            <InfoIcon />
          </span>
          <p className="leading-relaxed">
            {findings.length === 0 ? (
              <>
                Start by <span className="font-medium text-primary">recording</span> a narrated walk-through, or{" "}
                <span className="font-medium text-primary">adding</span> a finding and typing it in. You can edit,
                reorder and preview everything afterwards.
              </>
            ) : (
              <>
                Click <span className="font-medium text-primary">Edit</span> on a finding to fix its text, drag to
                reorder the teaching sequence, then{" "}
                <span className="font-medium text-primary">Preview as student</span> to see the replay. Every change
                saves automatically.
              </>
            )}
          </p>
        </div>

        {undo && (
          <div className="mb-4 flex animate-fade-up items-center justify-between gap-3 rounded-xl border border-strong bg-elevated px-4 py-3 text-sm">
            <span className="text-secondary">
              Deleted <span className="font-medium text-primary">{undo.finding.label || "finding"}</span>.
            </span>
            <Button size="sm" variant="secondary" onClick={undoDelete}>
              Undo
            </Button>
          </div>
        )}

        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-primary">
            Teaching sequence
            <span className="rounded-full bg-elevated px-2 py-0.5 text-xs tabular-nums text-muted">
              {findings.length}
            </span>
          </h2>
          {findings.length > 1 && <p className="text-xs text-muted">Drag the handle or use the arrows to reorder.</p>}
        </div>

        {findings.length === 0 ? (
          <EmptyState
            icon={<LayersIcon />}
            title="No findings yet — record your first read"
            description="Record a narrated walk-through of the study, or add a finding and type it in. Either way you can refine it afterwards."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button leadingIcon={<Mic className="h-4 w-4" />} onClick={() => setShowRecord(true)}>
                  Record finding
                </Button>
                <Button variant="secondary" leadingIcon={<PlusIcon />} onClick={() => setShowAdd(true)}>
                  Add finding
                </Button>
              </div>
            }
          />
        ) : (
          <FindingsList
            findings={findings}
            onSaveFinding={saveFinding}
            onDeleteFinding={(id) => setDeleteTarget(findings.find((f) => f.id === id) ?? null)}
            onMove={move}
            onReorder={applyReorder}
            onPreview={openPreview}
            onDirtyChange={onDirtyChange}
          />
        )}
      </PageContainer>

      <AddFindingDialog open={showAdd} onClose={() => setShowAdd(false)} onCreate={createFinding} />

      <RecordFindingDialog open={showRecord} onClose={() => setShowRecord(false)} caseId={caseId} onCreate={createFinding} />

      <EditCaseModal
        caseId={showEditDetails ? caseData.caseId : null}
        authors={authors}
        onClose={() => setShowEditDetails(false)}
        onSaved={(updated) => {
          setCaseData((c) => (c ? { ...c, ...updated } : c));
          setShowEditDetails(false);
        }}
      />

      <Modal
        open={!!deleteTarget}
        onClose={() => !deleting && setDeleteTarget(null)}
        title="Delete this finding?"
        description="This removes the finding and its viewer state from the teaching sequence. This can't be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} loading={deleting}>
              Delete finding
            </Button>
          </>
        }
      >
        {deleteTarget && (
          <p>
            <span className="font-medium text-primary">{deleteTarget.label}</span>
            {deleteTarget.description ? ` — ${deleteTarget.description}` : ""}
          </p>
        )}
      </Modal>
    </div>
  );
}

function WorkspaceSkeleton() {
  return (
    <div className="animate-fade-in">
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Studio", href: "/studio/cases" }, { label: "…" }]} />}
        title={<Skeleton className="h-6 w-48" />}
        description={<Skeleton className="mt-1 h-4 w-32" />}
      />
      <PageContainer width="narrow">
        <Skeleton className="mb-4 h-5 w-40" />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-subtle bg-elevated p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <Skeleton className="h-6 w-6 rounded-md" />
                <Skeleton className="h-4 w-40" />
              </div>
              <Skeleton className="mt-3 h-3 w-full" />
              <Skeleton className="mt-2 h-3 w-2/3" />
            </div>
          ))}
        </div>
      </PageContainer>
    </div>
  );
}
