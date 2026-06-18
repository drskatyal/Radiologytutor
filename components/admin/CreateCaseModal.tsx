"use client";

// Create-case flow: upload one or more DICOM studies → set title / modality /
// specialty / patient → pick each study's series + primary + role → create the
// Case (with its Patient + Studies + study links) via the admin API.

import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Field,
  Input,
  Modal,
  Select,
  useToast,
} from "@/components/ui";
import { IconButton } from "@/components/ui";
import { DicomDropzone } from "./DicomDropzone";
import { SeriesPicker, type SeriesOption } from "./SeriesPicker";
import { createCase, type CreateCaseInput } from "./api";
import {
  MODALITIES,
  SPECIALTIES,
  STUDY_ROLES,
  type Case,
  type Patient,
  type StudyRole,
  type UploadResult,
} from "./types";

/** One uploaded study staged for the case (grouped from an upload result). */
interface StagedStudy {
  key: string;
  studyInstanceUID: string;
  description: string;
  modality?: string;
  series: SeriesOption[];
  /** Series UIDs the case uses (first = primary). */
  selected: string[];
  primary?: string;
  role: StudyRole;
}

/** Group a raw upload result into one staged study per StudyInstanceUID. */
function stageFromUpload(result: UploadResult): StagedStudy[] {
  const byStudy = new Map<string, StagedStudy>();
  for (const s of result.series) {
    let staged = byStudy.get(s.studyInstanceUID);
    if (!staged) {
      staged = {
        key: s.studyInstanceUID,
        studyInstanceUID: s.studyInstanceUID,
        description: s.description || "Uploaded study",
        series: [],
        selected: [],
        role: "current",
      };
      byStudy.set(s.studyInstanceUID, staged);
    }
    staged.series.push({
      seriesInstanceUID: s.seriesInstanceUID,
      label: s.description || `Series …${s.seriesInstanceUID.slice(-6)}`,
      instanceCount: s.instances,
    });
  }
  // Default: select the first series of each study as primary.
  for (const staged of byStudy.values()) {
    if (staged.series[0]) {
      staged.selected = [staged.series[0].seriesInstanceUID];
      staged.primary = staged.series[0].seriesInstanceUID;
    }
  }
  return [...byStudy.values()];
}

export function CreateCaseModal({
  open,
  onClose,
  patients,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  patients: Patient[];
  onCreated: (created: Case) => void;
}) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [modality, setModality] = useState("CT");
  const [specialty, setSpecialty] = useState("");
  const [patientMode, setPatientMode] = useState<"new" | "existing">("new");
  const [patientName, setPatientName] = useState("");
  const [patientId, setPatientId] = useState("");
  const [studies, setStudies] = useState<StagedStudy[]>([]);
  const [saving, setSaving] = useState(false);

  function reset() {
    setTitle("");
    setModality("CT");
    setSpecialty("");
    setPatientMode("new");
    setPatientName("");
    setPatientId("");
    setStudies([]);
    setSaving(false);
  }

  function close() {
    if (saving) return;
    reset();
    onClose();
  }

  function handleUploaded(result: UploadResult) {
    const staged = stageFromUpload(result);
    setStudies((prev) => {
      // Dedupe by studyInstanceUID; later studies become priors by default.
      const existing = new Set(prev.map((s) => s.studyInstanceUID));
      const additions = staged
        .filter((s) => !existing.has(s.studyInstanceUID))
        .map((s) => ({ ...s, role: prev.length ? ("prior" as StudyRole) : s.role }));
      const next = [...prev, ...additions];
      // Auto-fill modality + title from the first study if still default/empty.
      if (additions[0]) {
        if (!title.trim()) setTitle(additions[0].description);
        if (additions[0].modality) setModality(additions[0].modality);
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
          caseSeriesInstanceUIDs: ordered,
          role: s.role,
        };
      });
      const input: CreateCaseInput = {
        title: title.trim(),
        modality,
        specialty: specialty || undefined,
        status: "draft",
        ...(patientMode === "existing"
          ? { patientId }
          : { patientName: patientName.trim() }),
        studies: studyPayload.length ? studyPayload : undefined,
      };
      const created = await createCase(input);
      toast({
        title: "Case created",
        description: `"${created.title}" saved as a draft.`,
        variant: "success",
      });
      reset();
      onCreated(created);
    } catch (e) {
      toast({
        title: "Could not create case",
        description: (e as Error).message,
        variant: "danger",
      });
      setSaving(false);
    }
  }

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
          <SectionLabel step={1} title="Imaging" />
          <DicomDropzone onUploaded={handleUploaded} disabled={saving} />
          {studies.length > 0 && (
            <div className="flex flex-col gap-3">
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
                      <div className="mt-0.5 text-xs text-muted">
                        {s.series.length} series · {s.selected.length} selected
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
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75">
                          <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
                        </svg>
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
                  {i === 0 && studies.length > 1 && (
                    <p className="mt-2 text-xs text-muted">
                      Tip: upload another study to add a prior or comparison.
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
          <Field label="Title" required>
            {(p) => (
              <Input
                {...p}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Acute appendicitis on CT"
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Modality">
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
            <Field label="Patient" required>
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
          {studies.length === 0 && (
            <Badge variant="info" className="self-start">
              You can create the case now and link imaging later.
            </Badge>
          )}
        </section>
      </div>
    </Modal>
  );
}

function SectionLabel({ step, title }: { step: number; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold tabular-nums text-accent">
        {step}
      </span>
      <h3 className="text-sm font-semibold text-primary">{title}</h3>
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
