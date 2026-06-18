"use client";

// /author — the teacher's review & edit surface.
//
// Two states:
//   1. Case picker — pick a case to review.
//   2. Findings review/edit — read-only case metadata header + the ordered list
//      of findings as editable cards. Edit structured text inline, reorder
//      (buttons or drag), delete (confirmed), add, and re-run Gemini structuring.
//
// Every write is optimistic with a toast and rollback on failure. Metadata
// (title/modality/status) is read-only here — editing it is Admin's job.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/AppShell";
import {
  Button,
  Badge,
  EmptyState,
  Modal,
  Skeleton,
  useToast,
} from "@/components/ui";
import type { CaseData, Finding } from "@/lib/types";
import { CasePicker } from "@/components/author/CasePicker";
import { FindingsList } from "@/components/author/FindingsList";
import { AddFindingDialog } from "@/components/author/AddFindingDialog";
import { RecordFindingDialog } from "@/components/author/RecordFindingDialog";
import {
  addFinding,
  deleteFinding,
  fetchCase,
  fetchCases,
  patchFinding,
  reorderFindings,
} from "@/components/author/lib";
import { BackIcon, LayersIcon, PlusIcon } from "@/components/author/icons";

export default function AuthorPage() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <AuthorRouter />
    </Suspense>
  );
}

function AuthorRouter() {
  const params = useSearchParams();
  const caseId = params.get("case");
  // Key on caseId so switching cases fully remounts the workspace state.
  return caseId ? <CaseWorkspace key={caseId} caseId={caseId} /> : <CaseSelection />;
}

function RouteFallback() {
  return (
    <div className="animate-fade-in">
      <PageHeader title="Author" />
      <div className="mx-auto max-w-6xl px-6 py-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// 1. Case selection
// ===========================================================================

function CaseSelection() {
  const router = useRouter();
  const { toast } = useToast();
  const [cases, setCases] = useState<CaseData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const data = await fetchCases();
        if (alive) setCases(data);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load cases");
        toast({ variant: "danger", title: "Couldn't load cases" });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [toast]);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Author"
        description="Pick a case to review and refine its findings — structured text, teaching sequence and more."
      />
      <div className="mx-auto max-w-6xl px-6 py-6">
        <CasePicker
          cases={cases}
          loading={loading}
          error={error}
          onSelect={(id) => router.push(`/author?case=${encodeURIComponent(id)}`)}
        />
      </div>
    </div>
  );
}

// ===========================================================================
// 2. Findings review / edit workspace
// ===========================================================================

function CaseWorkspace({ caseId }: { caseId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [caseData, setCaseData] = useState<CaseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showRecord, setShowRecord] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Finding | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  const findings = useMemo(
    () => (caseData ? [...caseData.findings].sort((a, b) => a.order - b.order) : []),
    [caseData]
  );

  // --- mutations (optimistic + toast + rollback) --------------------------

  async function saveFinding(findingId: string, patch: Partial<Finding>) {
    if (!caseData) return;
    const snapshot = caseData;
    // Optimistic: apply the patch locally first.
    setCaseData({
      ...caseData,
      findings: caseData.findings.map((f) =>
        f.id === findingId ? { ...f, ...patch } : f
      ),
    });
    try {
      const updated = await patchFinding(caseId, findingId, patch);
      setCaseData(updated);
      toast({ variant: "success", title: "Finding saved" });
    } catch (e) {
      setCaseData(snapshot);
      toast({
        variant: "danger",
        title: "Couldn't save finding",
        description: e instanceof Error ? e.message : undefined,
      });
      throw e; // let the card stay in edit mode
    }
  }

  async function confirmDelete() {
    if (!caseData || !deleteTarget) return;
    const snapshot = caseData;
    const target = deleteTarget;
    setDeleting(true);
    // Optimistic removal.
    setCaseData({
      ...caseData,
      findings: caseData.findings.filter((f) => f.id !== target.id),
    });
    try {
      const updated = await deleteFinding(caseId, target.id);
      setCaseData(updated);
      toast({ variant: "success", title: "Finding deleted" });
      setDeleteTarget(null);
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
    // Optimistic reorder: rewrite `order` to match the new sequence.
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
      throw e; // keep the dialog open
    }
  }

  // --- render -------------------------------------------------------------

  const backButton = (
    <Button
      variant="ghost"
      size="sm"
      leadingIcon={<BackIcon />}
      onClick={() => router.push("/author")}
    >
      All cases
    </Button>
  );

  if (loading) return <WorkspaceSkeleton back={backButton} />;

  if (error || !caseData) {
    return (
      <div className="animate-fade-in">
        <PageHeader title="Author" actions={backButton} />
        <div className="mx-auto max-w-3xl px-6 py-10">
          <EmptyState
            title="Couldn't open this case"
            description={error || "The case may have been removed."}
            action={
              <Button variant="secondary" onClick={() => router.push("/author")}>
                Back to cases
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={caseData.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{caseData.modality}</Badge>
            {caseData.status && (
              <Badge variant={caseData.status === "published" ? "success" : "warning"}>
                {caseData.status}
              </Badge>
            )}
            {caseData.specialty && <Badge variant="neutral">{caseData.specialty}</Badge>}
            <span className="text-xs text-muted">·</span>
            <span className="text-xs text-muted">{caseData.caseId}</span>
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            {backButton}
            {findings.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push(`/case/${caseData.caseId}`)}
              >
                Preview playback
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<RecordDotIcon />}
              onClick={() => setShowRecord(true)}
            >
              Record finding
            </Button>
            <Button size="sm" leadingIcon={<PlusIcon />} onClick={() => setShowAdd(true)}>
              Add finding
            </Button>
          </div>
        }
      />

      <div className="mx-auto max-w-4xl px-6 py-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-primary">
            Teaching sequence
            <span className="rounded-full bg-elevated px-2 py-0.5 text-xs tabular-nums text-muted">
              {findings.length}
            </span>
          </h2>
          {findings.length > 1 && (
            <p className="text-xs text-muted">Drag the handle or use the arrows to reorder.</p>
          )}
        </div>

        {findings.length === 0 ? (
          <EmptyState
            icon={<LayersIcon />}
            title="No findings yet"
            description="Add the first finding to start building this case's teaching sequence."
            action={
              <Button leadingIcon={<PlusIcon />} onClick={() => setShowAdd(true)}>
                Add finding
              </Button>
            }
          />
        ) : (
          <FindingsList
            findings={findings}
            onSaveFinding={saveFinding}
            onDeleteFinding={(id) =>
              setDeleteTarget(findings.find((f) => f.id === id) ?? null)
            }
            onMove={move}
            onReorder={applyReorder}
          />
        )}
      </div>

      <AddFindingDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onCreate={createFinding}
      />

      <RecordFindingDialog
        open={showRecord}
        onClose={() => setShowRecord(false)}
        onCreate={createFinding}
      />

      <Modal
        open={!!deleteTarget}
        onClose={() => !deleting && setDeleteTarget(null)}
        title="Delete this finding?"
        description="This removes the finding and its viewer state from the teaching sequence. This can't be undone."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
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

// ---------------------------------------------------------------------------

function RecordDotIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-4 w-4">
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="3" fill="currentColor" stroke="none" />
    </svg>
  );
}

function WorkspaceSkeleton({ back }: { back: React.ReactNode }) {
  return (
    <div className="animate-fade-in">
      <PageHeader
        title={<Skeleton className="h-6 w-48" />}
        description={<Skeleton className="mt-1 h-4 w-32" />}
        actions={back}
      />
      <div className="mx-auto max-w-4xl px-6 py-6">
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
      </div>
    </div>
  );
}
