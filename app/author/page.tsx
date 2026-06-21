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

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useUnsavedGuard } from "@/components/author/useUnsavedGuard";
import { UploadCaseWizard } from "@/components/cases/UploadCaseWizard";
import {
  fetchAuthors,
  fetchPatients,
} from "@/components/admin/api";
import type { Author, Patient } from "@/components/admin/types";
import {
  addFinding,
  deleteFinding,
  fetchCase,
  fetchCases,
  patchFinding,
  reorderFindings,
} from "@/components/author/lib";
import {
  BackIcon,
  InfoIcon,
  LayersIcon,
  MicIcon,
  PlayIcon,
  PlusIcon,
} from "@/components/author/icons";

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
  // Author-side create-case flow: same modal admin uses, so authors can upload
  // a study and create a teaching case, then drop straight into authoring it.
  const [createOpen, setCreateOpen] = useState(false);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [authors, setAuthors] = useState<Author[]>([]);

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
      // Patients + authors power the create-case modal's pickers. Best-effort:
      // a failure here just means the modal opens with empty pickers (the author
      // can still create a new patient inline), so we never block the list.
      try {
        const [ps, au] = await Promise.all([fetchPatients(), fetchAuthors()]);
        if (alive) {
          setPatients(ps);
          setAuthors(au);
        }
      } catch {
        /* non-fatal — the modal degrades gracefully */
      }
    })();
    return () => {
      alive = false;
    };
  }, [toast]);

  const newCaseButton = (
    <Button
      size="sm"
      leadingIcon={<PlusIcon />}
      onClick={() => setCreateOpen(true)}
    >
      New case
    </Button>
  );

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Author"
        description="Pick a case to review and refine its findings — or upload a study to start a new one."
        actions={newCaseButton}
      />
      <div className="mx-auto max-w-6xl px-6 py-6">
        <CasePicker
          cases={cases}
          loading={loading}
          error={error}
          onSelect={(id) => router.push(`/author?case=${encodeURIComponent(id)}`)}
          onCreate={() => setCreateOpen(true)}
        />
      </div>

      <UploadCaseWizard
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        patients={patients}
        authors={authors}
        onCreated={(created) => {
          // The wizard persists the case then routes straight into the recording
          // studio (steps 3–4). We just refresh the local list so it's there if
          // the author comes back.
          setCases((prev) =>
            prev.some((c) => c.caseId === created.caseId) ? prev : [created, ...prev]
          );
        }}
      />
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
  const [undo, setUndo] = useState<{ finding: Finding } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);

  // Track which findings have unsaved inline edits so we can guard navigation.
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
      onDirtyChange(findingId, false);
      toast({ variant: "success", title: "Finding saved" });
    } catch (e) {
      setCaseData(snapshot);
      toast({
        variant: "danger",
        title: "Couldn't save — your edits are kept",
        description:
          (e instanceof Error ? e.message : "Something went wrong.") +
          " Press Save again to retry.",
      });
      throw e; // let the card stay in edit mode so nothing is lost
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
      setDeleteTarget(null);
      // Offer a brief window to undo (re-create the exact finding).
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
      onClick={() => leaveTo("/author")}
    >
      All cases
    </Button>
  );

  const openPreview = () => leaveTo(`/case/${caseData?.caseId ?? ""}`);

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
              <div className="flex items-center justify-center gap-2">
                <Button variant="secondary" onClick={load}>
                  Try again
                </Button>
                <Button variant="ghost" onClick={() => router.push("/author")}>
                  Back to cases
                </Button>
              </div>
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
          <div className="flex items-center gap-2">
            {backButton}
            {findings.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<PlayIcon />}
                onClick={openPreview}
              >
                Preview as student
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<MicIcon />}
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
        {/* Plain-language guidance — the radiologist always knows the next step. */}
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-subtle bg-surface px-4 py-3 text-sm text-secondary [&_svg]:h-4 [&_svg]:w-4">
          <span className="mt-0.5 shrink-0 text-info">
            <InfoIcon />
          </span>
          <p className="leading-relaxed">
            {findings.length === 0 ? (
              <>
                Start by <span className="font-medium text-primary">recording</span> a
                narrated walk-through, or <span className="font-medium text-primary">adding</span>{" "}
                a finding and typing it in. You can edit, reorder and preview everything
                afterwards.
              </>
            ) : (
              <>
                Click <span className="font-medium text-primary">Edit</span> on a finding to
                fix its text, drag to reorder the teaching sequence, then{" "}
                <span className="font-medium text-primary">Preview as student</span> to see the
                replay. Every change saves automatically.
              </>
            )}
          </p>
        </div>

        {/* Undo banner after a delete (works without an action-slot toast). */}
        {undo && (
          <div className="mb-4 flex animate-fade-up items-center justify-between gap-3 rounded-xl border border-strong bg-elevated px-4 py-3 text-sm">
            <span className="text-secondary">
              Deleted{" "}
              <span className="font-medium text-primary">
                {undo.finding.label || "finding"}
              </span>
              .
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
          {findings.length > 1 && (
            <p className="text-xs text-muted">Drag the handle or use the arrows to reorder.</p>
          )}
        </div>

        {findings.length === 0 ? (
          <EmptyState
            icon={<LayersIcon />}
            title="No findings yet — record your first read"
            description="Record a narrated walk-through of the study, or add a finding and type it in. Either way you can refine it afterwards."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button leadingIcon={<MicIcon />} onClick={() => setShowRecord(true)}>
                  Record finding
                </Button>
                <Button
                  variant="secondary"
                  leadingIcon={<PlusIcon />}
                  onClick={() => setShowAdd(true)}
                >
                  Add finding
                </Button>
              </div>
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
            onPreview={openPreview}
            onDirtyChange={onDirtyChange}
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
        caseId={caseId}
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
