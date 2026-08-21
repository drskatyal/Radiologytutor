"use client";

// Admin console: Cases (org oversight), Teachers (verification placeholder),
// Platform (super-admin tools on the roadmap). Auth gates land via lib/auth.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CircleAlert, LayoutGrid, Users } from "lucide-react";
import {
  Breadcrumbs,
  Button,
  EmptyState,
  Modal,
  PageContainer,
  Skeleton,
  Tabs,
  useToast,
} from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { useCallbackRef } from "./useCallbackRef";
import { CaseList } from "./CaseList";
import { EditCaseModal } from "./EditCaseModal";
import { TeachersQueue } from "./TeachersQueue";
import { PlatformPanel } from "./PlatformPanel";
import { MembersPanel } from "./MembersPanel";
import {
  deleteCase as apiDeleteCase,
  fetchAuthors,
  fetchCases,
  fetchPatients,
  updateCase as apiUpdateCase,
} from "./api";
import type { AdminCaseRow, Author, Case, CaseStatus, Patient } from "./types";

type Filter = "all" | CaseStatus;
type Section = "cases" | "teachers" | "members" | "platform";

export function AdminConsole() {
  const { toast } = useToast();
  const [cases, setCases] = useState<AdminCaseRow[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [section, setSection] = useState<Section>("cases");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editId, setEditId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminCaseRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const reload = useCallbackRef(async () => {
    try {
      const [cs, ps, au] = await Promise.all([fetchCases(), fetchPatients(), fetchAuthors()]);
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

  function mergeCase(updated: Case) {
    setCases((prev) =>
      prev.map((c) =>
        c.caseId === updated.caseId
          ? {
              ...c,
              ...updated,
              patientName:
                patients.find((p) => p.id === updated.patientId)?.displayName ?? c.patientName,
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
    setCases((prev) => prev.map((x) => (x.caseId === c.caseId ? { ...x, status: next } : x)));
    try {
      await apiUpdateCase(c.caseId, { status: next });
      toast({
        title: next === "published" ? "Case published" : "Case unpublished",
        description: next === "published" ? "Students can now see this case." : "This case is hidden from students.",
        variant: "success",
      });
    } catch (e) {
      setCases((prev) => prev.map((x) => (x.caseId === c.caseId ? { ...x, status: c.status } : x)));
      toast({ title: "Could not update status", description: (e as Error).message, variant: "danger" });
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
      toast({ title: "Could not delete case", description: (e as Error).message, variant: "danger" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Admin" }]} />}
        title="Admin"
        description="Platform console — org admins oversee cases; Super-admins run teacher verification and marketplace health."
        actions={
          <Link href="/studio/new">
            <Button leadingIcon={<LayoutGrid className="h-4 w-4" aria-hidden="true" />}>New case</Button>
          </Link>
        }
      >
        <Tabs
          variant="underline"
          value={section}
          onValueChange={(v) => setSection(v as Section)}
          items={[
            { value: "cases", label: "Cases", icon: <LayoutGrid className="h-4 w-4" />, count: loading ? undefined : cases.length },
            { value: "teachers", label: "Teachers", icon: <Users className="h-4 w-4" />, count: loading ? undefined : authors.length },
            { value: "members", label: "Members" },
            { value: "platform", label: "Platform" },
          ]}
        />
        {section === "cases" && !loading && !loadError && cases.length > 0 && (
          <div className="mt-4">
            <Tabs
              value={filter}
              onValueChange={(v) => setFilter(v as Filter)}
              items={[
                { value: "all", label: "All", count: counts.all },
                { value: "published", label: "Published", count: counts.published },
                { value: "draft", label: "Drafts", count: counts.draft },
              ]}
            />
          </div>
        )}
      </PageHeader>

      <PageContainer className="flex flex-col gap-10">
        {section === "platform" ? (
          <PlatformPanel />
        ) : section === "members" ? (
          <MembersPanel />
        ) : section === "teachers" ? (
          <TeachersQueue
            authors={authors}
            loading={loading}
            error={loadError}
            onRetry={() => {
              setLoading(true);
              reload();
            }}
            onUpdated={(updated) => {
              setAuthors((prev) =>
                prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a))
              );
            }}
          />
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
            description="Cases created in Studio will appear here for oversight."
            action={
              <Link href="/studio/new">
                <Button>Create a case</Button>
              </Link>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState title={`No ${filter} cases`} description="Try a different filter." />
        ) : (
          <CaseList
            cases={visible}
            busyId={busyId}
            onEdit={(c) => setEditId(c.caseId)}
            onTogglePublish={togglePublish}
            onDelete={(c) => setPendingDelete(c)}
          />
        )}
      </PageContainer>

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
