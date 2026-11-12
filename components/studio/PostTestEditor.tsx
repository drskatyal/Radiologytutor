"use client";

// Studio / Courses → Post-test. The teacher builds the course's end-of-course
// quiz from the cases already in the course: multiple choice, click-the-finding
// (graded against the finding's authored marker, resolved server-side) and a
// written report (AI-graded against the case's authored findings). Learners
// take it on the course page, on the same viewer they learned on.

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  FileText,
  ListChecks,
  Plus,
  Target,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
  cn,
  useToast,
} from "@/components/ui";
import {
  deleteCourseAssessment,
  fetchCourseAssessment,
  saveCourseAssessment,
  type PostTestCase,
} from "@/components/admin/api";
import type { Course } from "@/components/admin/types";
import {
  MAX_HIT_RADIUS,
  MAX_QUESTIONS,
  MCQ_MAX_OPTIONS,
  MCQ_MIN_OPTIONS,
  MIN_HIT_RADIUS,
  type AssessmentDraft,
  type AssessmentDraftQuestion,
} from "@/lib/assessmentDraft";
import type { Assessment, Question } from "@/lib/types";

type Toast = ReturnType<typeof useToast>["toast"];

/** Editor row: a draft question plus a stable React key. */
type Row = AssessmentDraftQuestion & { key: string };

const KIND_LABEL: Record<Row["kind"], string> = {
  mcq: "Multiple choice",
  click_finding: "Click the finding",
  report: "Written report",
};

let keySeq = 0;
const nextKey = () => `row_${++keySeq}`;

function fromQuestion(q: Question): Row {
  if (q.kind === "mcq") {
    return {
      key: nextKey(),
      id: q.id,
      kind: "mcq",
      prompt: q.prompt,
      options: q.options.slice(),
      correctIndex: q.correctIndex,
      rationale: q.rationale ?? "",
    };
  }
  if (q.kind === "click_finding") {
    return {
      key: nextKey(),
      id: q.id,
      kind: "click_finding",
      prompt: q.prompt,
      caseId: q.caseId,
      findingId: q.findingId,
      toleranceRadiusPct: q.toleranceRadiusPct,
    };
  }
  return {
    key: nextKey(),
    id: q.id,
    kind: "report",
    prompt: q.prompt,
    caseId: q.caseId,
    findingIds: q.findingIds ?? [],
    passMark: q.passMark ?? 60,
  };
}

function blank(kind: Row["kind"], cases: PostTestCase[]): Row {
  const firstCase = cases[0];
  if (kind === "mcq") {
    return { key: nextKey(), kind, prompt: "", options: ["", "", "", ""], correctIndex: 0, rationale: "" };
  }
  if (kind === "click_finding") {
    const finding = firstCase?.findings.find((f) => f.hasMarker);
    return {
      key: nextKey(),
      kind,
      prompt: finding ? `Click the ${finding.label.toLowerCase()}.` : "",
      caseId: firstCase?.caseId ?? "",
      findingId: finding?.id ?? "",
      toleranceRadiusPct: 0.08,
    };
  }
  return {
    key: nextKey(),
    kind,
    prompt: firstCase ? `Review the study and write your report.` : "",
    caseId: firstCase?.caseId ?? "",
    findingIds: [],
    passMark: 60,
  };
}

function stripKey(row: Row): AssessmentDraftQuestion {
  const { key: _key, ...question } = row;
  return question as AssessmentDraftQuestion;
}

function toDraft(title: string, description: string, passingScore: number, rows: Row[]): AssessmentDraft {
  return {
    title,
    description,
    passingScore,
    questions: rows.map(stripKey),
  };
}

export function PostTestEditor({
  course,
  onClose,
  onSaved,
  toast,
}: {
  course: Course | null;
  onClose: () => void;
  /** Called with the question count after a save or delete (0 = no post-test). */
  onSaved?: (courseId: string, questionCount: number) => void;
  toast: Toast;
}) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [existing, setExisting] = useState<Assessment | null>(null);
  const [cases, setCases] = useState<PostTestCase[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [passingScore, setPassingScore] = useState(70);
  const [rows, setRows] = useState<Row[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!course) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setErrors([]);
    fetchCourseAssessment(course.id)
      .then(({ assessment, cases: cs }) => {
        if (cancelled) return;
        setExisting(assessment);
        setCases(cs);
        setTitle(assessment?.title ?? `${course.title} — post-test`);
        setDescription(assessment?.description ?? "");
        setPassingScore(assessment?.passingScore ?? 70);
        setRows(assessment ? assessment.questions.map(fromQuestion) : []);
      })
      .catch((e) => !cancelled && setLoadError((e as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [course, reloadTick]);

  function update(key: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? ({ ...r, ...patch } as Row) : r)));
  }

  function move(index: number, delta: number) {
    setRows((prev) => {
      const next = prev.slice();
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function save() {
    if (!course) return;
    setSaving(true);
    setErrors([]);
    try {
      const saved = await saveCourseAssessment(
        course.id,
        toDraft(title, description, passingScore, rows)
      );
      setExisting(saved);
      setRows(saved.questions.map(fromQuestion));
      toast({
        title: existing ? "Post-test updated" : "Post-test created",
        description: `${saved.questions.length} question${saved.questions.length === 1 ? "" : "s"} · pass ≥ ${saved.passingScore}%.`,
        variant: "success",
      });
      onSaved?.(course.id, saved.questions.length);
      onClose();
    } catch (e) {
      const message = (e as Error).message;
      setErrors([message]);
      toast({ title: "Could not save the post-test", description: message, variant: "danger" });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!course) return;
    setSaving(true);
    try {
      await deleteCourseAssessment(course.id);
      toast({ title: "Post-test removed", variant: "success" });
      onSaved?.(course.id, 0);
      setConfirmDelete(false);
      onClose();
    } catch (e) {
      toast({ title: "Could not remove", description: (e as Error).message, variant: "danger" });
    } finally {
      setSaving(false);
    }
  }

  const noCases = !loading && !loadError && cases.length === 0;
  const canAdd = rows.length < MAX_QUESTIONS;

  return (
    <>
      <Modal
        open={course != null && !confirmDelete}
        onClose={() => !saving && onClose()}
        size="xl"
        title={existing ? "Edit post-test" : "New post-test"}
        description={course ? `Required before a learner can claim the certificate for "${course.title}".` : undefined}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div>
              {existing && (
                <Button
                  variant="ghost"
                  onClick={() => setConfirmDelete(true)}
                  disabled={saving}
                  leadingIcon={<Trash2 className="h-4 w-4 text-danger" aria-hidden="true" />}
                >
                  Remove post-test
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button
                onClick={save}
                loading={saving}
                disabled={loading || !!loadError || noCases || rows.length === 0}
              >
                {existing ? "Save post-test" : "Create post-test"}
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading post-test">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : loadError ? (
            <EmptyState
              title="Couldn't load the post-test"
              description={loadError}
              action={
                <Button variant="secondary" onClick={() => setReloadTick((t) => t + 1)}>
                  Retry
                </Button>
              }
            />
          ) : noCases ? (
            <EmptyState
              icon={<ClipboardCheck aria-hidden="true" />}
              title="Add cases to the course first"
              description="Post-test questions are built on the course's cases. Edit the course and add at least one."
            />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
                <Field label="Title" required>
                  {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}
                </Field>
                <Field label="Pass mark (%)" required>
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      min={1}
                      max={100}
                      inputMode="numeric"
                      className="tabular-nums"
                      value={passingScore}
                      onChange={(e) => setPassingScore(Number(e.target.value))}
                    />
                  )}
                </Field>
              </div>
              <Field label="Instructions" hint="Shown to learners above the first question.">
                {(p) => (
                  <Textarea {...p} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
                )}
              </Field>

              {errors.length > 0 && (
                <div role="alert" className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
                  {errors.map((e) => (
                    <p key={e}>{e}</p>
                  ))}
                </div>
              )}

              {rows.length === 0 ? (
                <EmptyState
                  icon={<ListChecks aria-hidden="true" />}
                  title="No questions yet"
                  description="Mix multiple choice with questions on the images: click the finding, or write a report."
                />
              ) : (
                <ol className="flex flex-col gap-3">
                  {rows.map((row, i) => (
                    <QuestionCard
                      key={row.key}
                      index={i}
                      total={rows.length}
                      row={row}
                      cases={cases}
                      onChange={(patch) => update(row.key, patch)}
                      onMove={(d) => move(i, d)}
                      onRemove={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                    />
                  ))}
                </ol>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">Add a question:</span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canAdd}
                  onClick={() => setRows((r) => [...r, blank("mcq", cases)])}
                  leadingIcon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                >
                  Multiple choice
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canAdd}
                  onClick={() => setRows((r) => [...r, blank("click_finding", cases)])}
                  leadingIcon={<Target className="h-3.5 w-3.5" aria-hidden="true" />}
                >
                  Click the finding
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canAdd}
                  onClick={() => setRows((r) => [...r, blank("report", cases)])}
                  leadingIcon={<FileText className="h-3.5 w-3.5" aria-hidden="true" />}
                >
                  Written report
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => !saving && setConfirmDelete(false)}
        title="Remove post-test?"
        description="Learners will no longer need to pass it for the certificate. Past attempts are kept."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} loading={saving}>
              Remove post-test
            </Button>
          </>
        }
      />
    </>
  );
}

function QuestionCard({
  index,
  total,
  row,
  cases,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  total: number;
  row: Row;
  cases: PostTestCase[];
  onChange: (patch: Partial<Row>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const caseCtx = "caseId" in row ? cases.find((c) => c.caseId === row.caseId) : undefined;

  return (
    <li className="rounded-lg border border-subtle bg-elevated p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold tabular-nums text-muted">Q{index + 1}</span>
        <Badge variant="neutral">{KIND_LABEL[row.kind]}</Badge>
        <div className="ml-auto flex items-center gap-1">
          <IconButton aria-label="Move question up" variant="ghost" size="sm" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            aria-label="Move question down"
            variant="ghost"
            size="sm"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton aria-label="Delete question" variant="ghost" size="sm" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5 text-danger" />
          </IconButton>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Field label="Question" required>
          {(p) => <Textarea {...p} rows={2} value={row.prompt} onChange={(e) => onChange({ prompt: e.target.value })} />}
        </Field>

        {row.kind === "mcq" && (
          <McqFields row={row} onChange={onChange} />
        )}

        {(row.kind === "click_finding" || row.kind === "report") && (
          <Field label="Case">
            {(p) => (
              <Select
                {...p}
                value={row.caseId}
                onChange={(e) => {
                  const next = cases.find((c) => c.caseId === e.target.value);
                  if (row.kind === "click_finding") {
                    onChange({ caseId: e.target.value, findingId: next?.findings.find((f) => f.hasMarker)?.id ?? "" });
                  } else {
                    onChange({ caseId: e.target.value, findingIds: [] });
                  }
                }}
              >
                {cases.map((c) => (
                  <option key={c.caseId} value={c.caseId}>
                    {c.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        {row.kind === "click_finding" && (
          <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
            <Field
              label="Finding to locate"
              hint="Graded against the finding's marker from the case editor."
            >
              {(p) => (
                <Select {...p} value={row.findingId} onChange={(e) => onChange({ findingId: e.target.value })}>
                  <option value="" disabled>
                    Choose a finding
                  </option>
                  {(caseCtx?.findings ?? []).map((f) => (
                    <option key={f.id} value={f.id} disabled={!f.hasMarker}>
                      {f.label || "Untitled finding"}
                      {f.hasMarker ? "" : " (no marker)"}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Hit radius (%)"
              hint={`${Math.round(MIN_HIT_RADIUS * 100)}–${Math.round(MAX_HIT_RADIUS * 100)}% of the image.`}
            >
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  inputMode="numeric"
                  className="tabular-nums"
                  min={Math.round(MIN_HIT_RADIUS * 100)}
                  max={Math.round(MAX_HIT_RADIUS * 100)}
                  value={Math.round((row.toleranceRadiusPct ?? 0.08) * 100)}
                  onChange={(e) => onChange({ toleranceRadiusPct: Number(e.target.value) / 100 })}
                />
              )}
            </Field>
          </div>
        )}

        {row.kind === "report" && (
          <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-xs font-medium text-secondary">Graded findings</legend>
              {(caseCtx?.findings ?? []).length === 0 ? (
                <p className="text-xs text-warning">This case has no findings to grade against yet.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {caseCtx!.findings.map((f) => {
                    const ids = row.findingIds ?? [];
                    const all = ids.length === 0;
                    const checked = all || ids.includes(f.id);
                    return (
                      <li key={f.id}>
                        <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm text-secondary hover:bg-surface">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-strong bg-elevated text-accent accent-accent focus-visible:ring-2 focus-visible:ring-accent/60"
                            checked={checked}
                            onChange={() => {
                              const current = all ? caseCtx!.findings.map((x) => x.id) : ids;
                              const next = current.includes(f.id)
                                ? current.filter((x) => x !== f.id)
                                : [...current, f.id];
                              // Every finding ticked = "the whole case" (stored as no list).
                              onChange({
                                findingIds: next.length === caseCtx!.findings.length ? [] : next,
                              });
                            }}
                          />
                          {f.label || "Untitled finding"}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="text-xs text-muted">
                The rubric is built from these findings&apos; report gold lines (or descriptions).
              </p>
            </fieldset>
            <Field label="Pass mark (/100)">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  inputMode="numeric"
                  className="tabular-nums"
                  min={0}
                  max={100}
                  value={row.passMark ?? 60}
                  onChange={(e) => onChange({ passMark: Number(e.target.value) })}
                />
              )}
            </Field>
          </div>
        )}
      </div>
    </li>
  );
}

function McqFields({
  row,
  onChange,
}: {
  row: Extract<Row, { kind: "mcq" }>;
  onChange: (patch: Partial<Row>) => void;
}) {
  const options = row.options;
  return (
    <>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-xs font-medium text-secondary">
          Options — select the correct one
        </legend>
        {options.map((opt, idx) => {
          const correct = row.correctIndex === idx;
          return (
            <div key={idx} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onChange({ correctIndex: idx })}
                aria-pressed={correct}
                aria-label={`Mark option ${String.fromCharCode(65 + idx)} correct`}
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                  correct ? "text-success" : "text-muted hover:text-secondary"
                )}
              >
                {correct ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
              </button>
              <Input
                aria-label={`Option ${String.fromCharCode(65 + idx)}`}
                value={opt}
                placeholder={`Option ${String.fromCharCode(65 + idx)}`}
                onChange={(e) => {
                  const next = options.slice();
                  next[idx] = e.target.value;
                  onChange({ options: next });
                }}
              />
              <IconButton
                aria-label={`Remove option ${String.fromCharCode(65 + idx)}`}
                variant="ghost"
                size="sm"
                disabled={options.length <= MCQ_MIN_OPTIONS}
                onClick={() => {
                  const next = options.filter((_, i) => i !== idx);
                  const ci = row.correctIndex;
                  onChange({
                    options: next,
                    correctIndex: ci === idx ? 0 : ci > idx ? ci - 1 : ci,
                  });
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          );
        })}
        <div>
          <Button
            size="sm"
            variant="ghost"
            disabled={options.length >= MCQ_MAX_OPTIONS}
            onClick={() => onChange({ options: [...options, ""] })}
            leadingIcon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            Add option
          </Button>
        </div>
      </fieldset>
      <Field label="Why (shown after a pass)">
        {(p) => (
          <Textarea {...p} rows={2} value={row.rationale ?? ""} onChange={(e) => onChange({ rationale: e.target.value })} />
        )}
      </Field>
    </>
  );
}
