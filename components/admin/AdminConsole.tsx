"use client";

// The admin console: list + manage all of the org's teaching cases, and create
// new ones from an uploaded DICOM study. Owns data fetching, status filtering,
// optimistic publish/unpublish, delete-with-confirm, and the create/edit modals.

import { useEffect, useMemo, useState } from "react";
import { CircleAlert, Library, LayoutGrid, Plus } from "lucide-react";
import {
  Button,
  EmptyState,
  Modal,
  Skeleton,
  Tabs,
  useToast,
} from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { useCallbackRef } from "./useCallbackRef";
import { CaseList } from "./CaseList";
import { CreateCaseModal } from "@/components/cases/CreateCaseModal";
import { EditCaseModal } from "./EditCaseModal";
import { LibraryManager } from "./LibraryManager";
import {
  deleteCase as apiDeleteCase,
  fetchAuthors,
  fetchCases,
  fetchPatients,
  updateCase as apiUpdateCase,
} from "./api";
import type { AdminCaseRow, Author, Case, CaseStatus, Patient } from "./types";

type Filter = "all" | CaseStatus;
type Section = "cases" | "library";

export function AdminConsole() {
  const { toast } = useToast();
  const [section, setSection] = useState<Section>("cases");
  const [cases, setCases] = useState<AdminCaseRow[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminCaseRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const reload = useCallbackRef(async () => {
    try {
      const [cs, ps, au] = await Promise.all([
        fetchCases(),
        fetchPatients(),
        fetchAuthors(),
      ]);
      setCases(cs);
      setPatients(ps);
      setAuthors(au);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  });

  useEffect(() => {
    reload();
  }, [reload]);

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

  /** Merge an updated case back into the list, recomputing denormalized fields. */
  function mergeCase(updated: Case) {
    setCases((prev) =>
      prev.map((c) =>
        c.caseId === updated.caseId
          ? {
              ...c,
              ...updated,
              patientName:
                patients.find((p) => p.id === updated.patientId)?.displayName ??
                c.patientName,
              studyCount: updated.studyRefs?.length ?? 0,
              findingCount: updated.findings.length,
            }
          : c
      )
    );
  }

  async function togglePublish(c: AdminCaseRow) {
    const next: CaseStatus = c.status === "published" ? "draft" : "published";
    setBusyId(c.caseId);
    // Optimistic update with rollback on failure.
    setCases((prev) =>
      prev.map((x) => (x.caseId === c.caseId ? { ...x, status: next } : x))
    );
    try {
      await apiUpdateCase(c.caseId, { status: next });
      toast({
        title: next === "published" ? "Case published" : "Case unpublished",
        description:
          next === "published"
            ? "Students can now see this case."
            : "This case is hidden from students.",
        variant: "success",
      });
    } catch (e) {
      setCases((prev) =>
        prev.map((x) => (x.caseId === c.caseId ? { ...x, status: c.status } : x))
      );
      toast({
        title: "Could not update status",
        description: (e as Error).message,
        variant: "danger",
      });
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
      toast({ title: "Case deleted", description: `"${target.title}" removed.`, variant: "success" });
      setPendingDelete(null);
    } catch (e) {
      toast({
        title: "Could not delete case",
        description: (e as Error).message,
        variant: "danger",
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Admin"
        description="Upload studies and manage your organization's teaching cases and library."
        actions={
          section === "cases" && (
            <Button
              onClick={() => setCreateOpen(true)}
              leadingIcon={<Plus className="h-4 w-4" aria-hidden="true" />}
            >
              New case
            </Button>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            value={section}
            onValueChange={(v) => setSection(v as Section)}
            items={[
              { value: "cases", label: "Cases", icon: <LayoutGrid className="h-4 w-4" /> },
              { value: "library", label: "Library", icon: <Library className="h-4 w-4" /> },
            ]}
          />
          {section === "cases" && !loading && !loadError && cases.length > 0 && (
            <Tabs
              value={filter}
              onValueChange={(v) => setFilter(v as Filter)}
              items={[
                { value: "all", label: "All", count: counts.all },
                { value: "published", label: "Published", count: counts.published },
                { value: "draft", label: "Drafts", count: counts.draft },
              ]}
            />
          )}
        </div>
      </PageHeader>

      <div className="mx-auto max-w-6xl px-6 py-6">
        {section === "library" ? (
          <LibraryManager cases={cases} authors={authors} onAuthorsChanged={setAuthors} />
        ) : loading ? (
          <LoadingList />
        ) : loadError ? (
          <EmptyState
            icon={<CircleAlert aria-hidden="true" />}
            title="Couldn't load cases"
            description={loadError}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setLoading(true);
                  reload();
                }}
              >
                Retry
              </Button>
            }
          />
        ) : cases.length === 0 ? (
          <EmptyState
            icon={<LayoutGrid aria-hidden="true" />}
            title="No cases yet"
            description="Upload a DICOM study to create your first teaching case."
            action={<Button onClick={() => setCreateOpen(true)}>Create a case</Button>}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title={`No ${filter} cases`}
            description="Try a different filter, or create a new case."
          />
        ) : (
          <CaseList
            cases={visible}
            busyId={busyId}
            onEdit={(c) => setEditId(c.caseId)}
            onTogglePublish={togglePublish}
            onDelete={(c) => setPendingDelete(c)}
          />
        )}
      </div>

      <CreateCaseModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        patients={patients}
        authors={authors}
        onCreated={() => {
          // The modal shows its own success step + next-step actions and closes
          // itself; we just refresh the list (and patients, for new ones) in the
          // background so the new draft appears.
          reload();
        }}
      />

      <EditCaseModal
        caseId={editId}
        authors={authors}
        onClose={() => setEditId(null)}
        onSaved={(updated) => {
          mergeCase(updated);
          setEditId(null);
        }}
      />

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
    </>
  );
}

function LoadingList() {
  return (
    <div className="overflow-hidden rounded-xl border border-subtle bg-elevated">
      <ul className="divide-y divide-subtle">
        {Array.from({ length: 5 }).map((_, i) => (
          <li key={i} className="flex items-center gap-4 px-4 py-4">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="mt-2 h-3 w-32" />
            </div>
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-8 w-24" />
          </li>
        ))}
      </ul>
    </div>
  );
}
