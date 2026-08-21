"use client";

// Studio / Courses & playlists — group the author's own published cases into
// guided courses or lightweight playlists. Ported from the old admin "Library"
// tab (LibraryManager) so course/playlist management lives in the teaching
// home instead of a cross-org admin surface.

import { useEffect, useMemo, useState } from "react";
import { GraduationCap, ListMusic, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  PageContainer,
  Select,
  Skeleton,
  Tabs,
  Textarea,
  useToast,
} from "@/components/ui";
import { StudioHeader } from "./StudioHeader";
import { difficultyLabel } from "@/lib/taxonomy";
import { CaseOrderPicker } from "@/components/admin/CaseOrderPicker";
import {
  createCourse,
  createPlaylist,
  deleteCourse,
  deletePlaylist,
  fetchAuthors,
  fetchCases,
  fetchCourses,
  fetchPlaylists,
  updateCourse,
  updatePlaylist,
} from "@/components/admin/api";
import {
  BODY_SYSTEMS,
  DIFFICULTIES,
  type AdminCaseRow,
  type Author,
  type BodySystem,
  type CaseStatus,
  type Course,
  type Difficulty,
  type Playlist,
} from "@/components/admin/types";

type Tab = "courses" | "playlists";
type Toast = ReturnType<typeof useToast>["toast"];

export function CoursesAndPlaylists() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("courses");
  const [cases, setCases] = useState<AdminCaseRow[]>([]);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    Promise.all([fetchCases(), fetchAuthors(), fetchCourses(), fetchPlaylists()])
      .then(([cs, au, co, pl]) => {
        setCases(cs);
        setAuthors(au);
        setCourses(co);
        setPlaylists(pl);
        setError(null);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const caseTitleById = useMemo(
    () => Object.fromEntries(cases.map((c) => [c.caseId, c.title])),
    [cases]
  );

  return (
    <div className="animate-fade-in">
      <StudioHeader active="courses" />
      <PageContainer>
        {error ? (
          <EmptyState
            title="Couldn't load courses & playlists"
            description={error}
            action={
              <Button variant="secondary" onClick={load}>
                Retry
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-5">
            <Tabs
              variant="underline"
              value={tab}
              onValueChange={(v) => setTab(v as Tab)}
              items={[
                { value: "courses", label: "Courses", icon: <GraduationCap className="h-4 w-4" />, count: courses.length },
                { value: "playlists", label: "Playlists", icon: <ListMusic className="h-4 w-4" />, count: playlists.length },
              ]}
            />

            {loading ? (
              <ListSkeleton />
            ) : tab === "courses" ? (
              <CoursesPanel
                courses={courses}
                setCourses={setCourses}
                authors={authors}
                cases={cases}
                caseTitleById={caseTitleById}
                toast={toast}
              />
            ) : (
              <PlaylistsPanel
                playlists={playlists}
                setPlaylists={setPlaylists}
                cases={cases}
                caseTitleById={caseTitleById}
                toast={toast}
              />
            )}
          </div>
        )}
      </PageContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

function CoursesPanel({
  courses,
  setCourses,
  authors,
  cases,
  caseTitleById,
  toast,
}: {
  courses: Course[];
  setCourses: React.Dispatch<React.SetStateAction<Course[]>>;
  authors: Author[];
  cases: AdminCaseRow[];
  caseTitleById: Record<string, string>;
  toast: Toast;
}) {
  const [editing, setEditing] = useState<Course | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Course | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove(c: Course) {
    setBusy(true);
    try {
      await deleteCourse(c.id);
      setCourses((prev) => prev.filter((x) => x.id !== c.id));
      toast({ title: "Course deleted", variant: "success" });
      setPendingDelete(null);
    } catch (e) {
      toast({ title: "Could not delete", description: (e as Error).message, variant: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PanelHeader
        title="Courses"
        description="Group your published cases into a guided, ordered course."
        onNew={() => setEditing("new")}
        newLabel="New course"
      />
      {courses.length === 0 ? (
        <EmptyState
          icon={<GraduationCap aria-hidden="true" />}
          title="No courses yet"
          description="Group your published cases into a guided, ordered course."
          action={<Button onClick={() => setEditing("new")}>New course</Button>}
        />
      ) : (
        <ul className="divide-y divide-subtle overflow-hidden rounded-xl border border-subtle bg-elevated">
          {courses.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-primary">{c.title}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <Badge variant={c.status === "published" ? "success" : "neutral"}>{c.status}</Badge>
                  {c.difficulty && <span>{difficultyLabel(c.difficulty)}</span>}
                  {c.system && <span>· {c.system}</span>}
                  <span>
                    · {c.caseIds.length} case{c.caseIds.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
              <IconButton aria-label="Edit course" variant="ghost" onClick={() => setEditing(c)}>
                <Pencil className="h-4 w-4" />
              </IconButton>
              <IconButton aria-label="Delete course" variant="ghost" onClick={() => setPendingDelete(c)}>
                <Trash2 className="h-4 w-4 text-danger" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <CourseModal
        value={editing}
        authors={authors}
        cases={cases}
        caseTitleById={caseTitleById}
        onClose={() => setEditing(null)}
        onSaved={(saved, isNew) => {
          setCourses((prev) => (isNew ? [saved, ...prev] : prev.map((x) => (x.id === saved.id ? saved : x))));
          setEditing(null);
        }}
        toast={toast}
      />

      <ConfirmDelete
        open={pendingDelete != null}
        busy={busy}
        label={pendingDelete?.title}
        kind="course"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && remove(pendingDelete)}
      />
    </>
  );
}

function CourseModal({
  value,
  authors,
  cases,
  caseTitleById,
  onClose,
  onSaved,
  toast,
}: {
  value: Course | "new" | null;
  authors: Author[];
  cases: AdminCaseRow[];
  caseTitleById: Record<string, string>;
  onClose: () => void;
  onSaved: (course: Course, isNew: boolean) => void;
  toast: Toast;
}) {
  const isNew = value === "new";
  const course = value && value !== "new" ? value : null;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty | "">("");
  const [system, setSystem] = useState<BodySystem | "">("");
  const [authorId, setAuthorId] = useState("");
  const [status, setStatus] = useState<CaseStatus>("draft");
  const [caseIds, setCaseIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!value) return;
    setTitle(course?.title ?? "");
    setDescription(course?.description ?? "");
    setDifficulty(course?.difficulty ?? "");
    setSystem(course?.system ?? "");
    setAuthorId(course?.authorId ?? "");
    setStatus(course?.status ?? "draft");
    setCaseIds(course?.caseIds ?? []);
  }, [value, course]);

  async function save() {
    if (!title.trim()) {
      toast({ title: "Title is required", variant: "danger" });
      return;
    }
    setSaving(true);
    try {
      const input = {
        title: title.trim(),
        description: description.trim() || undefined,
        difficulty: difficulty || undefined,
        system: system || undefined,
        authorId: authorId || undefined,
        status,
        caseIds,
      };
      const saved = isNew || !course ? await createCourse(input) : await updateCourse(course.id, input);
      toast({ title: isNew ? "Course created" : "Course updated", variant: "success" });
      onSaved(saved, isNew);
    } catch (e) {
      toast({ title: "Could not save", description: (e as Error).message, variant: "danger" });
      setSaving(false);
    }
  }

  return (
    <Modal
      open={value != null}
      onClose={() => !saving && onClose()}
      size="xl"
      title={isNew ? "New course" : "Edit course"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            {isNew ? "Create course" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto pr-1">
        <Field label="Title" required>
          {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />}
        </Field>
        <Field label="Description">
          {(p) => <Textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Difficulty">
            {(p) => (
              <Select {...p} value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty | "")}>
                <option value="">Unspecified</option>
                {DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>
                    {difficultyLabel(d)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="System">
            {(p) => (
              <Select {...p} value={system} onChange={(e) => setSystem(e.target.value as BodySystem | "")}>
                <option value="">Unspecified</option>
                {BODY_SYSTEMS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Author">
            {(p) => (
              <Select {...p} value={authorId} onChange={(e) => setAuthorId(e.target.value)}>
                <option value="">Unattributed</option>
                {authors.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Status">
            {(p) => (
              <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as CaseStatus)}>
                <option value="draft">Draft</option>
                <option value="published">Published</option>
              </Select>
            )}
          </Field>
        </div>
        <CaseOrderPicker cases={cases} caseTitleById={caseTitleById} selected={caseIds} onChange={setCaseIds} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

function PlaylistsPanel({
  playlists,
  setPlaylists,
  cases,
  caseTitleById,
  toast,
}: {
  playlists: Playlist[];
  setPlaylists: React.Dispatch<React.SetStateAction<Playlist[]>>;
  cases: AdminCaseRow[];
  caseTitleById: Record<string, string>;
  toast: Toast;
}) {
  const [editing, setEditing] = useState<Playlist | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Playlist | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove(p: Playlist) {
    setBusy(true);
    try {
      await deletePlaylist(p.id);
      setPlaylists((prev) => prev.filter((x) => x.id !== p.id));
      toast({ title: "Playlist deleted", variant: "success" });
      setPendingDelete(null);
    } catch (e) {
      toast({ title: "Could not delete", description: (e as Error).message, variant: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PanelHeader
        title="Playlists"
        description="Curate a quick ordered list of cases for the library."
        onNew={() => setEditing("new")}
        newLabel="New playlist"
      />
      {playlists.length === 0 ? (
        <EmptyState
          icon={<ListMusic aria-hidden="true" />}
          title="No playlists yet"
          description="Curate a quick ordered list of cases for the library."
          action={<Button onClick={() => setEditing("new")}>New playlist</Button>}
        />
      ) : (
        <ul className="divide-y divide-subtle overflow-hidden rounded-xl border border-subtle bg-elevated">
          {playlists.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-primary">{p.title}</div>
                <div className="truncate text-xs text-muted">
                  {p.caseIds.length} case{p.caseIds.length === 1 ? "" : "s"}
                </div>
              </div>
              <IconButton aria-label="Edit playlist" variant="ghost" onClick={() => setEditing(p)}>
                <Pencil className="h-4 w-4" />
              </IconButton>
              <IconButton aria-label="Delete playlist" variant="ghost" onClick={() => setPendingDelete(p)}>
                <Trash2 className="h-4 w-4 text-danger" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <PlaylistModal
        value={editing}
        cases={cases}
        caseTitleById={caseTitleById}
        onClose={() => setEditing(null)}
        onSaved={(saved, isNew) => {
          setPlaylists((prev) => (isNew ? [saved, ...prev] : prev.map((x) => (x.id === saved.id ? saved : x))));
          setEditing(null);
        }}
        toast={toast}
      />

      <ConfirmDelete
        open={pendingDelete != null}
        busy={busy}
        label={pendingDelete?.title}
        kind="playlist"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && remove(pendingDelete)}
      />
    </>
  );
}

function PlaylistModal({
  value,
  cases,
  caseTitleById,
  onClose,
  onSaved,
  toast,
}: {
  value: Playlist | "new" | null;
  cases: AdminCaseRow[];
  caseTitleById: Record<string, string>;
  onClose: () => void;
  onSaved: (playlist: Playlist, isNew: boolean) => void;
  toast: Toast;
}) {
  const isNew = value === "new";
  const playlist = value && value !== "new" ? value : null;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [caseIds, setCaseIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!value) return;
    setTitle(playlist?.title ?? "");
    setDescription(playlist?.description ?? "");
    setCaseIds(playlist?.caseIds ?? []);
  }, [value, playlist]);

  async function save() {
    if (!title.trim()) {
      toast({ title: "Title is required", variant: "danger" });
      return;
    }
    setSaving(true);
    try {
      const input = {
        title: title.trim(),
        description: description.trim() || undefined,
        caseIds,
      };
      const saved = isNew || !playlist ? await createPlaylist(input) : await updatePlaylist(playlist.id, input);
      toast({ title: isNew ? "Playlist created" : "Playlist updated", variant: "success" });
      onSaved(saved, isNew);
    } catch (e) {
      toast({ title: "Could not save", description: (e as Error).message, variant: "danger" });
      setSaving(false);
    }
  }

  return (
    <Modal
      open={value != null}
      onClose={() => !saving && onClose()}
      size="xl"
      title={isNew ? "New playlist" : "Edit playlist"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            {isNew ? "Create playlist" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto pr-1">
        <Field label="Title" required>
          {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />}
        </Field>
        <Field label="Description">
          {(p) => <Textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />}
        </Field>
        <CaseOrderPicker cases={cases} caseTitleById={caseTitleById} selected={caseIds} onChange={setCaseIds} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function PanelHeader({
  title,
  description,
  onNew,
  newLabel,
}: {
  title: string;
  description: string;
  onNew: () => void;
  newLabel: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-primary">{title}</h2>
        <p className="mt-0.5 text-xs text-muted">{description}</p>
      </div>
      <Button size="sm" onClick={onNew} leadingIcon={<Plus className="h-4 w-4" aria-hidden="true" />}>
        {newLabel}
      </Button>
    </div>
  );
}

function ConfirmDelete({
  open,
  busy,
  label,
  kind,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  label?: string;
  kind: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={() => !busy && onCancel()}
      title={`Delete ${kind}?`}
      description={label ? `"${label}" will be permanently removed. Cases are not affected.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy}>
            Delete {kind}
          </Button>
        </>
      }
    />
  );
}

function ListSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-subtle bg-elevated">
      <ul className="divide-y divide-subtle">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i} className="flex items-center gap-4 px-4 py-4">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="mt-2 h-3 w-28" />
            </div>
            <Skeleton className="h-8 w-8" />
          </li>
        ))}
      </ul>
    </div>
  );
}
