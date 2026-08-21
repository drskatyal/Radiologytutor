"use client";

// CreateCaseFlow — the ONE create-a-case pathway (steps 1-2 of the 4-step
// arc: Details -> Upload DICOM -> Record findings -> Publish). A full-page
// routed flow (not a modal) so the Stepper stays visible the whole journey:
// on "Create & record findings" we persist the case and hand off to
// /studio/cases/[caseId]/record, which renders the SAME Stepper advanced to
// step 3, with Publish as step 4 on that same surface.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Info, X } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import {
  Badge,
  Breadcrumbs,
  Button,
  Field,
  IconButton,
  Input,
  PageContainer,
  Select,
  Skeleton,
  Stepper,
  useToast,
} from "@/components/ui";
import { DicomDropzone } from "./DicomDropzone";
import { SeriesPicker } from "./SeriesPicker";
import { CASE_FLOW_STEPS, type CaseFlowStepId } from "./steps";
import {
  CaseDetailsForm,
  EMPTY_CASE_DETAILS,
  validateCaseDetails,
  type CaseDetailsValue,
} from "./CaseDetailsForm";
import { mergeUpload, totalStagedImages, toStudyPayload, type StagedStudy } from "./stagedStudies";
import {
  createCase,
  fetchAuthors,
  fetchOrthancStatus,
  fetchPatients,
  type CreateCaseInput,
} from "@/components/admin/api";
import { STUDY_ROLES, type Author, type Patient, type StudyRole, type UploadResult } from "@/components/admin/types";

export function CreateCaseFlow() {
  const { toast } = useToast();
  const router = useRouter();

  const [step, setStep] = useState<CaseFlowStepId>("details");
  const [details, setDetails] = useState<CaseDetailsValue>(EMPTY_CASE_DETAILS);
  const [titleAttempted, setTitleAttempted] = useState(false);

  const [patientMode, setPatientMode] = useState<"new" | "existing">("new");
  const [patientName, setPatientName] = useState("");
  const [patientId, setPatientId] = useState("");
  const [studies, setStudies] = useState<StagedStudy[]>([]);
  const [imagingOk, setImagingOk] = useState<boolean | null>(null);

  const [patients, setPatients] = useState<Patient[]>([]);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [loadingPickers, setLoadingPickers] = useState(true);

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchOrthancStatus().then(setImagingOk);
    Promise.all([fetchPatients(), fetchAuthors()])
      .then(([ps, au]) => {
        setPatients(ps);
        setAuthors(au);
      })
      .catch(() => {
        /* non-fatal — the pickers degrade gracefully */
      })
      .finally(() => setLoadingPickers(false));
  }, []);

  const titleError = validateCaseDetails(details).title;

  function patchDetails(patch: Partial<CaseDetailsValue>) {
    setDetails((d) => ({ ...d, ...patch }));
  }

  function handleUploaded(result: UploadResult) {
    setStudies((prev) => {
      const { next, firstNewStudy } = mergeUpload(prev, result);
      if (firstNewStudy) {
        if (!details.title.trim()) patchDetails({ title: firstNewStudy.description });
        if (firstNewStudy.modality) patchDetails({ modality: firstNewStudy.modality });
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
        const selected = has ? s.selected.filter((u) => u !== uid) : [...s.selected, uid];
        let primary = s.primary;
        if (has && primary === uid) primary = selected[0];
        if (!has && !primary) primary = uid;
        return { ...s, selected, primary };
      })
    );
  }

  const detailsValid = !titleError;
  const patientValid = patientMode === "new" ? !!patientName.trim() : !!patientId;
  const totalImages = totalStagedImages(studies);

  const hasDirtyInput =
    details.title.trim().length > 0 || patientName.trim().length > 0 || studies.length > 0;

  function goNext() {
    if (step === "details") {
      setTitleAttempted(true);
      if (!detailsValid) return;
      setStep("upload");
    }
  }
  function goBack() {
    if (step === "upload") setStep("details");
  }
  function cancel() {
    if (hasDirtyInput && !window.confirm("Discard this new case? Nothing has been saved yet.")) return;
    router.push("/studio");
  }

  async function createAndRecord() {
    if (saving) return;
    if (!detailsValid) {
      setTitleAttempted(true);
      setStep("details");
      return;
    }
    if (!patientValid) {
      toast({
        variant: "warning",
        title: "Add a patient label",
        description: "Give the case a non-PHI teaching label to continue.",
      });
      return;
    }
    setSaving(true);
    try {
      const input: CreateCaseInput = {
        title: details.title.trim(),
        modality: details.modality,
        specialty: details.specialty || undefined,
        status: "draft",
        difficulty: details.difficulty || undefined,
        system: details.system || undefined,
        tags: details.tags.length ? details.tags : undefined,
        authorId: details.authorId || undefined,
        clinicalHistory: details.clinicalHistory || undefined,
        patientAge: details.patientAge || undefined,
        patientSex: details.patientSex || undefined,
        technique: details.technique || undefined,
        primaryDiagnosis: details.primaryDiagnosis || undefined,
        differentials: details.differentials.filter(Boolean).length
          ? details.differentials.filter(Boolean)
          : undefined,
        targetLevel: details.targetLevel || undefined,
        learningObjectives: details.learningObjectives.filter(Boolean).length
          ? details.learningObjectives.filter(Boolean)
          : undefined,
        discussion: details.discussion || undefined,
        references: details.references.filter(Boolean).length ? details.references.filter(Boolean) : undefined,
        ...(patientMode === "existing" ? { patientId } : { patientName: patientName.trim() }),
        studies: studies.length ? toStudyPayload(studies) : undefined,
      };
      const created = await createCase(input);
      toast({
        title: "Case created",
        description: `"${created.title}" saved as a draft. Time to record.`,
        variant: "success",
      });
      router.push(`/studio/cases/${encodeURIComponent(created.caseId)}/record`);
    } catch (e) {
      toast({
        variant: "danger",
        title: "Could not create case",
        description: e instanceof Error ? e.message : undefined,
      });
      setSaving(false);
    }
  }

  const guidance =
    step === "details" ? (
      <>
        Compose the case the way you teach it. Only a <span className="font-medium text-primary">title</span> is
        required now — everything else you can refine later. <span className="font-medium text-primary">Next:</span>{" "}
        attach the DICOM study.
      </>
    ) : (
      <>
        Upload an anonymized study; pick the series learners will read. Imaging is optional now — you can link it
        later. <span className="font-medium text-primary">Next:</span> the recording studio opens on this case so
        you can capture each finding by voice.
      </>
    );

  return (
    <div className="animate-fade-in">
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Studio", href: "/studio" }, { label: "New case" }]} />}
        title="New teaching case"
        description="Build the case the way you teach it — stem, diagnosis, pedagogy — then attach the study and record."
      >
        <Stepper steps={CASE_FLOW_STEPS} currentId={step} />
      </PageHeader>

      <PageContainer width="narrow" className="pb-28">
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-info/30 bg-info/5 px-4 py-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
          <p className="text-xs leading-relaxed text-secondary">{guidance}</p>
        </div>

        {step === "details" ? (
          loadingPickers ? (
            <DetailsSkeleton />
          ) : (
            <CaseDetailsForm value={details} onChange={patchDetails} authors={authors} showTitleError={titleAttempted} />
          )
        ) : (
          <UploadStep
            imagingOk={imagingOk}
            setImagingOk={setImagingOk}
            saving={saving}
            studies={studies}
            setStudies={setStudies}
            onUploaded={handleUploaded}
            updateStudy={updateStudy}
            toggleSeries={toggleSeries}
            setPrimary={(key, uid) => updateStudy(key, { primary: uid })}
            totalImages={totalImages}
            patientMode={patientMode}
            setPatientMode={setPatientMode}
            patientName={patientName}
            setPatientName={setPatientName}
            patientId={patientId}
            setPatientId={setPatientId}
            patients={patients}
          />
        )}
      </PageContainer>

      {/* Sticky footer actions — always visible so the arc's next step is one click away. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-subtle bg-surface/95 backdrop-blur md:pl-60">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-6 py-4 sm:px-8">
          {step === "details" ? (
            <>
              <Button variant="ghost" onClick={cancel} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={goNext} trailingIcon={<ArrowRight className="h-4 w-4" />}>
                Continue to upload
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={goBack} disabled={saving} leadingIcon={<ArrowLeft className="h-4 w-4" />}>
                Back
              </Button>
              <Button onClick={createAndRecord} loading={saving} disabled={!patientValid}>
                Create &amp; record findings
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────

function UploadStep({
  imagingOk,
  setImagingOk,
  saving,
  studies,
  setStudies,
  onUploaded,
  updateStudy,
  toggleSeries,
  setPrimary,
  totalImages,
  patientMode,
  setPatientMode,
  patientName,
  setPatientName,
  patientId,
  setPatientId,
  patients,
}: {
  imagingOk: boolean | null;
  setImagingOk: (v: boolean) => void;
  saving: boolean;
  studies: StagedStudy[];
  setStudies: React.Dispatch<React.SetStateAction<StagedStudy[]>>;
  onUploaded: (r: UploadResult) => void;
  updateStudy: (key: string, patch: Partial<StagedStudy>) => void;
  toggleSeries: (key: string, uid: string) => void;
  setPrimary: (key: string, uid: string) => void;
  totalImages: number;
  patientMode: "new" | "existing";
  setPatientMode: (m: "new" | "existing") => void;
  patientName: string;
  setPatientName: (v: string) => void;
  patientId: string;
  setPatientId: (v: string) => void;
  patients: Patient[];
}) {
  const patientError =
    patientMode === "existing" && patients.length === 0 ? "No patients yet — create a new one above." : undefined;

  return (
    <div className="flex flex-col gap-6">
      {/* Patient */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold text-primary">Patient</h3>
          <p className="text-xs text-muted">
            A non-PHI teaching label groups this study with any priors for comparison.
          </p>
        </div>
        <div className="flex gap-2">
          <ModeToggle active={patientMode === "new"} onClick={() => setPatientMode("new")}>
            New patient
          </ModeToggle>
          <ModeToggle
            active={patientMode === "existing"}
            onClick={() => setPatientMode("existing")}
            disabled={patients.length === 0}
          >
            Existing patient
          </ModeToggle>
        </div>
        {patientMode === "new" ? (
          <Field label="Teaching label" hint="No PHI, e.g. “Case A — 54M”." required>
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
              <Select {...p} value={patientId} onChange={(e) => setPatientId(e.target.value)}>
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
      </section>

      {/* Imaging */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold text-primary">DICOM study</h3>
          <p className="text-xs text-muted">
            Upload an anonymized study; we group it into series you can preview and pick from.
          </p>
        </div>

        {imagingOk === false ? (
          <div className="flex items-start gap-3 rounded-xl border border-info/30 bg-info/5 px-4 py-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
            <div className="text-xs leading-relaxed text-secondary">
              <p className="font-medium text-primary">Imaging archive not connected</p>
              <p className="mt-0.5 text-muted">
                You can still create the case and record against the sample study now — link a real study later from
                the case&apos;s editor.
              </p>
            </div>
          </div>
        ) : (
          <DicomDropzone onUploaded={onUploaded} onImagingUnavailable={() => setImagingOk(false)} disabled={saving} />
        )}

        {studies.length > 0 && (
          <div className="flex flex-col gap-3">
            {totalImages > 0 && (
              <p className="text-xs text-muted">
                {studies.length} stud{studies.length === 1 ? "y" : "ies"} · <span className="tabular-nums">{totalImages}</span>{" "}
                image{totalImages === 1 ? "" : "s"} uploaded
              </p>
            )}
            {studies.map((s) => (
              <div key={s.key} className="rounded-xl border border-subtle bg-surface p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-primary">{s.description}</div>
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
                      onChange={(e) => updateStudy(s.key, { role: e.target.value as StudyRole })}
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
                      onClick={() => setStudies((prev) => prev.filter((x) => x.key !== s.key))}
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
              </div>
            ))}
          </div>
        )}

        {studies.length === 0 && imagingOk !== false && (
          <Badge variant="info" className="self-start">
            Imaging is optional now — you can attach a study later.
          </Badge>
        )}
      </section>

      <div className="flex items-start gap-3 rounded-xl border border-subtle bg-surface px-4 py-3">
        <span className="mt-0.5 shrink-0 text-info">
          <Info className="h-4 w-4" aria-hidden="true" />
        </span>
        <p className="text-xs leading-relaxed text-secondary">
          Next, the recording studio opens on this case&apos;s series. Hold{" "}
          <kbd className="rounded border border-strong bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-secondary">
            Alt
          </kbd>
          {" + "}
          <kbd className="rounded border border-strong bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-secondary">
            X
          </kbd>{" "}
          (or the Record button) to capture each finding by voice, then review and publish.
        </p>
      </div>
    </div>
  );
}

function ModeToggle({
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
      className={
        "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 " +
        "disabled:cursor-not-allowed disabled:opacity-40 " +
        (active
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-strong bg-elevated text-secondary hover:text-primary")
      }
    >
      {children}
    </button>
  );
}
