"use client";

// Edit a case's metadata (title/modality/specialty/status) and its study links.
// Study links drive the patient chronology: each linked study has a role
// (current/prior/comparison) and an order so a case can compare prior vs current.
// Studies are shown chronologically (oldest first) from the patient's timeline.

import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  cn,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  useToast,
} from "@/components/ui";
import { fetchCaseDetail, updateCase } from "./api";
import { formatStudyDate } from "./format";
import { difficultyLabel } from "@/lib/taxonomy";
import {
  BODY_SYSTEMS,
  DIFFICULTIES,
  MODALITIES,
  SPECIALTIES,
  STUDY_ROLES,
  type Author,
  type BodySystem,
  type Case,
  type CaseStatus,
  type CaseStudyRef,
  type Difficulty,
  type Patient,
  type Study,
  type StudyRole,
} from "./types";

/** A study from the patient timeline + whether/how the case links it. */
interface LinkRow {
  study: Study;
  linked: boolean;
  role: StudyRole;
  order: number;
  /** The series this case used (preserved from the existing ref; [] = all). */
  caseSeriesInstanceUIDs: string[];
}

export function EditCaseModal({
  caseId,
  authors = [],
  onClose,
  onSaved,
}: {
  caseId: string | null;
  authors?: Author[];
  onClose: () => void;
  onSaved: (updated: Case) => void;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [modality, setModality] = useState("CT");
  const [specialty, setSpecialty] = useState("");
  const [status, setStatus] = useState<CaseStatus>("draft");
  const [difficulty, setDifficulty] = useState<Difficulty | "">("");
  const [system, setSystem] = useState<BodySystem | "">("");
  const [tags, setTags] = useState("");
  const [authorId, setAuthorId] = useState("");
  const [patient, setPatient] = useState<Patient | null>(null);
  const [links, setLinks] = useState<LinkRow[]>([]);

  useEffect(() => {
    if (!caseId) return;
    let active = true;
    setLoading(true);
    setError(null);
    fetchCaseDetail(caseId)
      .then(({ case: c, patient, studies }) => {
        if (!active) return;
        setTitle(c.title);
        setModality(c.modality || "CT");
        setSpecialty(c.specialty ?? "");
        setStatus(c.status);
        setDifficulty(c.difficulty ?? "");
        setSystem(c.system ?? "");
        setTags((c.tags ?? []).join(", "));
        setAuthorId(c.authorId ?? "");
        setPatient(patient);
        const refByUid = new Map<string, CaseStudyRef>(
          (c.studyRefs ?? []).map((r) => [r.studyInstanceUID, r])
        );
        setLinks(
          studies.map((study, i) => {
            const ref = refByUid.get(study.studyInstanceUID);
            return {
              study,
              linked: !!ref,
              role: (ref?.role as StudyRole) ?? (i === studies.length - 1 ? "current" : "prior"),
              order: ref?.order ?? i,
              caseSeriesInstanceUIDs: ref?.seriesInstanceUIDs ?? [],
            };
          })
        );
      })
      .catch((e) => active && setError((e as Error).message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [caseId]);

  function updateLink(uid: string, patch: Partial<LinkRow>) {
    setLinks((prev) =>
      prev.map((l) => (l.study.studyInstanceUID === uid ? { ...l, ...patch } : l))
    );
  }

  async function save() {
    if (!caseId || saving) return;
    if (!title.trim()) {
      toast({ title: "Title is required", variant: "danger" });
      return;
    }
    setSaving(true);
    try {
      const studyRefs: CaseStudyRef[] = links
        .filter((l) => l.linked)
        .sort((a, b) => a.order - b.order)
        .map((l, i) => ({
          studyInstanceUID: l.study.studyInstanceUID,
          // Preserve the series the case used (empty = all of the study's series).
          seriesInstanceUIDs: l.caseSeriesInstanceUIDs,
          role: l.role,
          order: i,
        }));
      const updated = await updateCase(caseId, {
        title: title.trim(),
        modality,
        specialty: specialty || null,
        status,
        studyRefs,
        difficulty: difficulty || null,
        system: system || null,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        authorId: authorId || null,
      });
      toast({ title: "Case updated", variant: "success" });
      onSaved(updated);
    } catch (e) {
      toast({
        title: "Could not save",
        description: (e as Error).message,
        variant: "danger",
      });
      setSaving(false);
    }
  }

  return (
    <Modal
      open={caseId != null}
      onClose={() => !saving && onClose()}
      size="xl"
      title="Edit case"
      description="Update metadata and the studies this case teaches from."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={loading || !!error}>
            Save changes
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
          <Spinner size="sm" label="Loading case" />
          Loading case…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : (
        <div className="flex max-h-[65vh] flex-col gap-5 overflow-y-auto pr-1">
          <Field label="Title" required>
            {(p) => (
              <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Modality">
              {(p) => (
                <Select {...p} value={modality} onChange={(e) => setModality(e.target.value)}>
                  {MODALITIES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Specialty">
              {(p) => (
                <Select {...p} value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
                  <option value="">Unspecified</option>
                  {SPECIALTIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Status">
              {(p) => (
                <Select
                  {...p}
                  value={status}
                  onChange={(e) => setStatus(e.target.value as CaseStatus)}
                >
                  <option value="draft">Draft</option>
                  <option value="published">Published</option>
                </Select>
              )}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Difficulty">
              {(p) => (
                <Select
                  {...p}
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value as Difficulty | "")}
                >
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
                <Select
                  {...p}
                  value={system}
                  onChange={(e) => setSystem(e.target.value as BodySystem | "")}
                >
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
                <Select
                  {...p}
                  value={authorId}
                  onChange={(e) => setAuthorId(e.target.value)}
                >
                  <option value="">Unattributed</option>
                  {authors.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          <Field label="Tags" hint="Comma-separated, e.g. fracture, PE, incidentaloma.">
            {(p) => (
              <Input
                {...p}
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="fracture, comparison, follow-up"
              />
            )}
          </Field>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-primary">
                Patient chronology
              </h3>
              {patient && (
                <span className="text-xs text-muted">{patient.displayName}</span>
              )}
            </div>
            {links.length === 0 ? (
              <p className="rounded-lg border border-dashed border-strong bg-surface/50 px-3 py-4 text-center text-xs text-muted">
                {patient
                  ? "This patient has no studies yet."
                  : "No patient is attached to this case."}
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {links.map((l) => (
                  <li
                    key={l.study.studyInstanceUID}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                      l.linked
                        ? "border-accent/40 bg-accent/5"
                        : "border-subtle bg-surface"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={l.linked}
                      onChange={(e) =>
                        updateLink(l.study.studyInstanceUID, { linked: e.target.checked })
                      }
                      className="h-4 w-4 shrink-0 accent-accent"
                      aria-label={`Link study from ${formatStudyDate(l.study.studyDate)}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-primary">
                        {l.study.description || "Study"}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs tabular-nums text-muted">
                        <span>{formatStudyDate(l.study.studyDate)}</span>
                        {l.study.modality && <span>· {l.study.modality}</span>}
                        <span>
                          · {l.study.seriesInstanceUIDs.length} series
                        </span>
                      </div>
                    </div>
                    {l.linked && (
                      <>
                        <Select
                          aria-label="Study role"
                          value={l.role}
                          onChange={(e) =>
                            updateLink(l.study.studyInstanceUID, {
                              role: e.target.value as StudyRole,
                            })
                          }
                          className="h-8 w-32 text-xs"
                        >
                          {STUDY_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r[0].toUpperCase() + r.slice(1)}
                            </option>
                          ))}
                        </Select>
                        <Input
                          type="number"
                          aria-label="Order"
                          value={l.order}
                          min={0}
                          onChange={(e) =>
                            updateLink(l.study.studyInstanceUID, {
                              order: Number(e.target.value),
                            })
                          }
                          className="h-8 w-16 text-xs tabular-nums"
                        />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
