"use client";

// Create-case flow: upload one or more DICOM studies → set title / modality /
// specialty / patient → pick each study's series + primary + role → create the
// Case (with its Patient + Studies + study links) via the admin API.
//
// Designed for a non-technical author (a radiologist, not an engineer):
//   • imaging is optional — if the archive isn't connected, the rest of the
//     flow still works and imaging can be linked later;
//   • uploaded instances are grouped study→series automatically and reviewed
//     with thumbnails, modality, and image counts;
//   • re-uploading the same study (same StudyInstanceUID) merges, never dupes;
//   • title/modality/patient are validated inline with helpful defaults;
//   • on success we confirm and offer an obvious next step.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Info, X } from "lucide-react";
import {
  Badge,
  Button,
  Field,
  IconButton,
  Input,
  Modal,
  Select,
  useToast,
} from "@/components/ui";
import { DicomDropzone } from "./DicomDropzone";
import { SeriesPicker, type SeriesOption } from "./SeriesPicker";
import { createCase, fetchOrthancStatus, type CreateCaseInput } from "./api";
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
  type Difficulty,
  type Patient,
  type StudyRole,
  type UploadResult,
} from "./types";

/** One uploaded study staged for the case (grouped from upload result[s]). */
interface StagedStudy {
  key: string;
  studyInstanceUID: string;
  description: string;
  modality?: string;
  studyDate?: string;
  orthancStudyId?: string;
  series: SeriesOption[];
  /** Series UIDs the case uses (first = primary). */
  selected: string[];
  primary?: string;
  role: StudyRole;
}

/**
 * Merge an upload result (one batch) into the staged-studies list, grouping by
 * StudyInstanceUID and by SeriesInstanceUID so multiple batches of the SAME
 * study/series accumulate instead of duplicating. Returns the next list plus
 * the first newly-seen study (for metadata auto-fill).
 */
function mergeUpload(
  prev: StagedStudy[],
  result: UploadResult
): { next: StagedStudy[]; firstNewStudy?: StagedStudy } {
  const next = prev.map((s) => ({ ...s, series: [...s.series], selected: [...s.selected] }));
  const byUid = new Map(next.map((s) => [s.studyInstanceUID, s]));
  let firstNewStudy: StagedStudy | undefined;

  for (const s of result.series) {
    let study = byUid.get(s.studyInstanceUID);
    if (!study) {
      study = {
        key: s.studyInstanceUID,
        studyInstanceUID: s.studyInstanceUID,
        description: s.studyDescription || "Uploaded study",
        modality: s.modality,
        studyDate: s.studyDate,
        orthancStudyId: s.orthancStudyId,
        series: [],
        selected: [],
        // First study uploaded is "current"; later ones default to "prior".
        role: next.length === 0 ? "current" : "prior",
      };
      byUid.set(s.studyInstanceUID, study);
      next.push(study);
      if (!firstNewStudy) firstNewStudy = study;
    }
    if (!study.orthancStudyId && s.orthancStudyId) study.orthancStudyId = s.orthancStudyId;
    if (!study.modality && s.modality) study.modality = s.modality;
    if (!study.studyDate && s.studyDate) study.studyDate = s.studyDate;

    const existing = study.series.find((x) => x.seriesInstanceUID === s.seriesInstanceUID);
    if (existing) {
      existing.instanceCount = (existing.instanceCount ?? 0) + s.instances;
      if (!existing.modality && s.modality) existing.modality = s.modality;
      if (!existing.firstInstanceUID && s.firstInstanceUID)
        existing.firstInstanceUID = s.firstInstanceUID;
    } else {
      study.series.push({
        seriesInstanceUID: s.seriesInstanceUID,
        label:
          s.seriesDescription ||
          s.studyDescription ||
          `Series …${s.seriesInstanceUID.slice(-6)}`,
        modality: s.modality,
        instanceCount: s.instances,
        studyInstanceUID: s.studyInstanceUID,
        firstInstanceUID: s.firstInstanceUID,
      });
    }
  }

  // Ensure every study has a primary/selection default (first series).
  for (const study of next) {
    if (study.selected.length === 0 && study.series[0]) {
      study.selected = [study.series[0].seriesInstanceUID];
      study.primary = study.series[0].seriesInstanceUID;
    }
  }
  return { next, firstNewStudy };
}

export function CreateCaseModal({
  open,
  onClose,
  patients,
  authors = [],
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  patients: Patient[];
  authors?: Author[];
  onCreated: (created: Case) => void;
}) {
  const { toast } = useToast();
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [modality, setModality] = useState("CT");
  const [specialty, setSpecialty] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty | "">("");
  const [system, setSystem] = useState<BodySystem | "">("");
  const [tags, setTags] = useState("");
  const [authorId, setAuthorId] = useState("");
  const [patientMode, setPatientMode] = useState<"new" | "existing">("new");
  const [patientName, setPatientName] = useState("");
  const [patientId, setPatientId] = useState("");
  const [studies, setStudies] = useState<StagedStudy[]>([]);
  const [saving, setSaving] = useState(false);
  /** null = unknown/checking; true/false once the status route answers. */
  const [imagingOk, setImagingOk] = useState<boolean | null>(null);
  const [created, setCreated] = useState<Case | null>(null);

  // Check imaging availability once the dialog opens, so we can show the calm
  // "not connected" path instead of letting an upload fail loudly.
  useEffect(() => {
    if (!open) return;
    let active = true;
    fetchOrthancStatus().then((ok) => active && setImagingOk(ok));
    return () => {
      active = false;
    };
  }, [open]);

  function reset() {
    setTitle("");
    setTitleTouched(false);
    setModality("CT");
    setSpecialty("");
    setDifficulty("");
    setSystem("");
    setTags("");
    setAuthorId("");
    setPatientMode("new");
    setPatientName("");
    setPatientId("");
    setStudies([]);
    setSaving(false);
    setCreated(null);
  }

  function close() {
    if (saving) return;
    reset();
    onClose();
  }

  function handleUploaded(result: UploadResult) {
    setStudies((prev) => {
      const { next, firstNewStudy } = mergeUpload(prev, result);
      if (firstNewStudy) {
        // Auto-fill title + modality from the first study when still untouched.
        if (!titleTouched && !title.trim()) setTitle(firstNewStudy.description);
        if (firstNewStudy.modality) setModality(firstNewStudy.modality);
      }
      return next;
    });
  }

  function updateStudy(key: string, patch: Partial<StagedStudy>) {
    setStudies((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  function toggleSeries(key: string, uid: string) {
    setStudies((prev) =>
      prev.map((s) => {
        if (s.key !== key) return s;
        const has = s.selected.includes(uid);
        const selected = has
          ? s.selected.filter((u) => u !== uid)
          : [...s.selected, uid];
        let primary = s.primary;
        if (has && primary === uid) primary = selected[0];
        if (!has && !primary) primary = uid;
        return { ...s, selected, primary };
      })
    );
  }

  function setPrimary(key: string, uid: string) {
    updateStudy(key, { primary: uid });
  }

  const titleError =
    titleTouched && !title.trim() ? "Give the case a short, descriptive title." : undefined;
  const patientError =
    patientMode === "existing" && patients.length === 0
      ? "No patients yet — create a new one above."
      : undefined;

  const canSubmit = useMemo(() => {
    if (!title.trim()) return false;
    if (patientMode === "new" && !patientName.trim()) return false;
    if (patientMode === "existing" && !patientId) return false;
    return true;
  }, [title, patientMode, patientName, patientId]);

  async function submit() {
    if (!canSubmit || saving) return;
    setSaving(true);
    try {
      const studyPayload = studies.map((s) => {
        // Order the chosen series with the primary first.
        const ordered = s.primary
          ? [s.primary, ...s.selected.filter((u) => u !== s.primary)]
          : s.selected;
        return {
          studyInstanceUID: s.studyInstanceUID,
          seriesInstanceUIDs: s.series.map((x) => x.seriesInstanceUID),
          description: s.description,
          modality: s.modality,
          studyDate: s.studyDate,
          orthancStudyId: s.orthancStudyId,
          caseSeriesInstanceUIDs: ordered,
          role: s.role,
        };
      });
      const input: CreateCaseInput = {
        title: title.trim(),
        modality,
        specialty: specialty || undefined,
        status: "draft",
        difficulty: difficulty || undefined,
        system: system || undefined,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        authorId: authorId || undefined,
        ...(patientMode === "existing"
          ? { patientId }
          : { patientName: patientName.trim() }),
        studies: studyPayload.length ? studyPayload : undefined,
      };
      const result = await createCase(input);
      toast({
        title: "Case created",
        description: `"${result.title}" saved as a draft.`,
        variant: "success",
      });
      onCreated(result);
      // Switch to the success step (don't reset yet — we need the new id).
      setCreated(result);
      setSaving(false);
    } catch (e) {
      toast({
        title: "Could not create case",
        description: (e as Error).message,
        variant: "danger",
      });
      setSaving(false);
    }
  }

  const totalImages = studies.reduce(
    (n, s) => n + s.series.reduce((m, x) => m + (x.instanceCount ?? 0), 0),
    0
  );

  // -- Success step -----------------------------------------------------------
  if (created) {
    return (
      <Modal
        open={open}
        onClose={close}
        size="md"
        title="Case created"
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                close();
                router.push(`/case/${encodeURIComponent(created.caseId)}`);
              }}
            >
              Open case
            </Button>
            <Button
              onClick={() => {
                close();
                router.push(`/author?case=${encodeURIComponent(created.caseId)}`);
              }}
            >
              Add findings
            </Button>
          </>
        }
      >
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
            <Check className="h-6 w-6" aria-hidden="true" />
          </div>
          <p className="text-sm text-secondary">
            <span className="font-medium text-primary">{created.title}</span> is saved as a draft.
          </p>
          <p className="max-w-sm text-xs text-muted">
            Next, record the teaching walk-through and mark each finding in the author
            workspace. The case stays hidden from students until you publish it.
          </p>
        </div>
      </Modal>
    );
  }

  // -- Create form ------------------------------------------------------------
  return (
    <Modal
      open={open}
      onClose={close}
      size="xl"
      title="New teaching case"
      description="Upload a study, set the metadata, then pick the series to teach from."
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving} disabled={!canSubmit}>
            Create case
          </Button>
        </>
      }
    >
      <div className="flex max-h-[65vh] flex-col gap-6 overflow-y-auto pr-1">
        {/* Step 1 — imaging */}
        <section className="flex flex-col gap-3">
          <SectionLabel step={1} title="Imaging" optional />
          {imagingOk === false ? (
            <div className="flex items-start gap-3 rounded-xl border border-info/30 bg-info/5 px-4 py-3">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
              <div className="text-xs leading-relaxed text-secondary">
                <p className="font-medium text-primary">Imaging archive not connected</p>
                <p className="mt-0.5 text-muted">
                  You can still create this case now and link a study later — just fill in
                  the details below and click Create case.
                </p>
              </div>
            </div>
          ) : (
            <DicomDropzone
              onUploaded={handleUploaded}
              onImagingUnavailable={() => setImagingOk(false)}
              disabled={saving}
            />
          )}

          {studies.length > 0 && (
            <div className="flex flex-col gap-3">
              {totalImages > 0 && (
                <p className="text-xs text-muted">
                  {studies.length} stud{studies.length === 1 ? "y" : "ies"} ·{" "}
                  <span className="tabular-nums">{totalImages}</span> image
                  {totalImages === 1 ? "" : "s"} uploaded
                </p>
              )}
              {studies.map((s, i) => (
                <div
                  key={s.key}
                  className="rounded-xl border border-subtle bg-surface p-4"
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-primary">
                        {s.description}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                        <span>
                          {s.series.length} series · {s.selected.length} selected
                        </span>
                        {s.modality && <span>· {s.modality}</span>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Select
                        aria-label="Study role"
                        value={s.role}
                        onChange={(e) =>
                          updateStudy(s.key, { role: e.target.value as StudyRole })
                        }
                        className="h-8 w-32 text-xs"
                      >
                        {STUDY_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r[0].toUpperCase() + r.slice(1)}
                          </option>
                        ))}
                      </Select>
                      <IconButton
                        aria-label="Remove study"
                        size="sm"
                        variant="danger"
                        onClick={() =>
                          setStudies((prev) => prev.filter((x) => x.key !== s.key))
                        }
                      >
                        <X aria-hidden="true" />
                      </IconButton>
                    </div>
                  </div>
                  <SeriesPicker
                    series={s.series}
                    selected={s.selected}
                    primary={s.primary}
                    onToggle={(uid) => toggleSeries(s.key, uid)}
                    onSetPrimary={(uid) => setPrimary(s.key, uid)}
                  />
                  {i === 0 && studies.length === 1 && imagingOk !== false && (
                    <p className="mt-2 text-xs text-muted">
                      Tip: upload another study above to add a prior or comparison.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Step 2 — metadata */}
        <section className="flex flex-col gap-4">
          <SectionLabel step={2} title="Case details" />
          <Field label="Title" required error={titleError}>
            {(p) => (
              <Input
                {...p}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => setTitleTouched(true)}
                placeholder="e.g. Acute appendicitis on CT"
                autoFocus
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Modality" hint="Auto-filled from the study when known.">
              {(p) => (
                <Select
                  {...p}
                  value={modality}
                  onChange={(e) => setModality(e.target.value)}
                >
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
                <Select
                  {...p}
                  value={specialty}
                  onChange={(e) => setSpecialty(e.target.value)}
                >
                  <option value="">Unspecified</option>
                  {SPECIALTIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
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
        </section>

        {/* Step 3 — patient */}
        <section className="flex flex-col gap-3">
          <SectionLabel step={3} title="Patient" />
          <div className="flex gap-2">
            <RoleToggle
              active={patientMode === "new"}
              onClick={() => setPatientMode("new")}
            >
              New patient
            </RoleToggle>
            <RoleToggle
              active={patientMode === "existing"}
              onClick={() => setPatientMode("existing")}
              disabled={patients.length === 0}
            >
              Existing patient
            </RoleToggle>
          </div>
          {patientMode === "new" ? (
            <Field
              label="Teaching label"
              hint="A non-PHI label, e.g. “Case A — 54M”."
              required
            >
              {(p) => (
                <Input
                  {...p}
                  value={patientName}
                  onChange={(e) => setPatientName(e.target.value)}
                  placeholder="Case A — 54M"
                />
              )}
            </Field>
          ) : (
            <Field label="Patient" required error={patientError}>
              {(p) => (
                <Select
                  {...p}
                  value={patientId}
                  onChange={(e) => setPatientId(e.target.value)}
                >
                  <option value="">Select a patient…</option>
                  {patients.map((pt) => (
                    <option key={pt.id} value={pt.id}>
                      {pt.displayName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {studies.length === 0 && imagingOk !== false && (
            <Badge variant="info" className="self-start">
              You can create the case now and link imaging later.
            </Badge>
          )}
        </section>
      </div>
    </Modal>
  );
}

function SectionLabel({
  step,
  title,
  optional,
}: {
  step: number;
  title: string;
  optional?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold tabular-nums text-accent">
        {step}
      </span>
      <h3 className="text-sm font-semibold text-primary">{title}</h3>
      {optional && <span className="text-xs text-muted">Optional</span>}
    </div>
  );
}

function RoleToggle({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={[
        "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-strong bg-elevated text-secondary hover:text-primary",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
