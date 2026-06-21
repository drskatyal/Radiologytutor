"use client";

// CaseDetailsForm — the exam-grade "teaching case" details form (step 1 of the
// Upload-case wizard, and reusable wherever a case's metadata is edited).
//
// This is deliberately NOT a generic CRUD form: it's laid out the way a
// radiology educator (FRCR / RANZCR / ACR) actually composes a teaching case:
//
//   • Stem        — clinical history, age/sex, modality, region/system, technique
//   • Diagnosis   — primary diagnosis + a RANKED differential + key teaching tags
//   • Pedagogy    — difficulty, target level, learning objectives
//   • Discussion  — long-form discussion + references / further reading
//
// It owns no persistence: the parent holds the `value` and gets `onChange`
// patches (controlled). Validation is inline + non-blocking except the title.
// The shape mirrors CaseDetailsInput + the existing create fields so the wizard
// can POST it straight to /api/admin/cases.

import { Plus, X } from "lucide-react";
import { Badge, Button, Field, IconButton, Input, Select, Textarea } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { difficultyLabel } from "@/lib/taxonomy";
import {
  BODY_SYSTEMS,
  DIFFICULTIES,
  MODALITIES,
  PATIENT_SEX_LABELS,
  PATIENT_SEXES,
  SPECIALTIES,
  TARGET_LEVEL_LABELS,
  TARGET_LEVELS,
  type Author,
  type BodySystem,
  type Difficulty,
  type PatientSex,
  type TargetLevel,
} from "@/components/admin/types";

/** Everything the details form edits. A superset of the legacy create fields. */
export interface CaseDetailsValue {
  title: string;
  modality: string;
  specialty: string;
  difficulty: Difficulty | "";
  system: BodySystem | "";
  tags: string[];
  authorId: string;
  // Exam-grade stem.
  clinicalHistory: string;
  patientAge: string;
  patientSex: PatientSex | "";
  technique: string;
  // Diagnosis.
  primaryDiagnosis: string;
  differentials: string[];
  // Pedagogy.
  targetLevel: TargetLevel | "";
  learningObjectives: string[];
  // Discussion.
  discussion: string;
  references: string[];
}

/** A sensible empty value — modality defaults to CT (the common case). */
export const EMPTY_CASE_DETAILS: CaseDetailsValue = {
  title: "",
  modality: "CT",
  specialty: "",
  difficulty: "",
  system: "",
  tags: [],
  authorId: "",
  clinicalHistory: "",
  patientAge: "",
  patientSex: "",
  technique: "",
  primaryDiagnosis: "",
  differentials: [],
  targetLevel: "",
  learningObjectives: [],
  discussion: "",
  references: [],
};

export interface CaseDetailsErrors {
  title?: string;
}

/** Validate the details. Only the title is required — the rest is encouraged. */
export function validateCaseDetails(v: CaseDetailsValue): CaseDetailsErrors {
  const errors: CaseDetailsErrors = {};
  if (!v.title.trim()) errors.title = "Give the case a short, descriptive title.";
  else if (v.title.trim().length > 140)
    errors.title = "Keep the title under 140 characters.";
  return errors;
}

export function CaseDetailsForm({
  value,
  onChange,
  authors = [],
  showTitleError = false,
  className,
}: {
  value: CaseDetailsValue;
  onChange: (patch: Partial<CaseDetailsValue>) => void;
  authors?: Author[];
  /** Surface the title error (e.g. after a submit attempt). */
  showTitleError?: boolean;
  className?: string;
}) {
  const errors = validateCaseDetails(value);

  return (
    <div className={cn("flex flex-col gap-7", className)}>
      {/* ── Stem ───────────────────────────────────────────────────────────── */}
      <Section
        title="Clinical stem"
        caption="The presentation a learner reads before the study — keep it real but non-PHI."
      >
        <Field label="Case title" required error={showTitleError ? errors.title : undefined}>
          {(p) => (
            <Input
              {...p}
              value={value.title}
              onChange={(e) => onChange({ title: e.target.value })}
              placeholder="e.g. Acute right lower quadrant pain in a young adult"
              maxLength={140}
              autoFocus
            />
          )}
        </Field>

        <Field
          label="Clinical history"
          hint="The referral / presenting complaint. Avoid any patient identifiers."
        >
          {(p) => (
            <Textarea
              {...p}
              rows={3}
              value={value.clinicalHistory}
              onChange={(e) => onChange({ clinicalHistory: e.target.value })}
              placeholder="e.g. 24M, 36h of migratory RIF pain, low-grade fever, raised WCC. Query appendicitis."
              maxLength={1000}
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Patient age" hint="A label, e.g. “54” or “6 months”.">
            {(p) => (
              <Input
                {...p}
                value={value.patientAge}
                onChange={(e) => onChange({ patientAge: e.target.value })}
                placeholder="e.g. 24"
                maxLength={24}
                inputMode="text"
              />
            )}
          </Field>
          <Field label="Sex">
            {(p) => (
              <Select
                {...p}
                value={value.patientSex}
                onChange={(e) => onChange({ patientSex: e.target.value as PatientSex | "" })}
              >
                <option value="">Unspecified</option>
                {PATIENT_SEXES.map((s) => (
                  <option key={s} value={s}>
                    {PATIENT_SEX_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Modality" hint="Auto-filled from the study when known.">
            {(p) => (
              <Select
                {...p}
                value={value.modality}
                onChange={(e) => onChange({ modality: e.target.value })}
              >
                {MODALITIES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Region / system">
            {(p) => (
              <Select
                {...p}
                value={value.system}
                onChange={(e) => onChange({ system: e.target.value as BodySystem | "" })}
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
          <Field label="Specialty">
            {(p) => (
              <Select
                {...p}
                value={value.specialty}
                onChange={(e) => onChange({ specialty: e.target.value })}
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

        <Field
          label="Technique / protocol"
          hint="Acquisition, contrast phase or sequence — what the learner should note."
        >
          {(p) => (
            <Input
              {...p}
              value={value.technique}
              onChange={(e) => onChange({ technique: e.target.value })}
              placeholder="e.g. Portal-venous phase CT abdomen/pelvis with IV contrast"
              maxLength={200}
            />
          )}
        </Field>
      </Section>

      {/* ── Diagnosis ──────────────────────────────────────────────────────── */}
      <Section
        title="Diagnosis & differential"
        caption="The teaching answer and the differentials a learner should reason through."
      >
        <Field label="Primary diagnosis" hint="The “answer” — revealed after the read.">
          {(p) => (
            <Input
              {...p}
              value={value.primaryDiagnosis}
              onChange={(e) => onChange({ primaryDiagnosis: e.target.value })}
              placeholder="e.g. Acute appendicitis with appendicolith"
              maxLength={200}
            />
          )}
        </Field>

        <RankedList
          label="Differential diagnoses"
          caption="Ranked most → likely least. Use the arrows to re-rank."
          ranked
          placeholder="e.g. Mesenteric adenitis"
          addLabel="Add differential"
          items={value.differentials}
          onChange={(differentials) => onChange({ differentials })}
          maxItems={8}
          maxLength={160}
        />

        <TagEditor
          tags={value.tags}
          onChange={(tags) => onChange({ tags })}
        />
      </Section>

      {/* ── Pedagogy ───────────────────────────────────────────────────────── */}
      <Section
        title="Pedagogy"
        caption="Pitch the case at a level and state what a learner should take away."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Difficulty">
            {(p) => (
              <Select
                {...p}
                value={value.difficulty}
                onChange={(e) => onChange({ difficulty: e.target.value as Difficulty | "" })}
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
          <Field label="Target level" hint="Who is this case for?">
            {(p) => (
              <Select
                {...p}
                value={value.targetLevel}
                onChange={(e) => onChange({ targetLevel: e.target.value as TargetLevel | "" })}
              >
                <option value="">Unspecified</option>
                {TARGET_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {TARGET_LEVEL_LABELS[l]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <RankedList
          label="Learning objectives"
          caption="“By the end, the learner can…”. One objective per line."
          placeholder="e.g. Recognise the secondary signs of appendicitis on CT"
          addLabel="Add objective"
          items={value.learningObjectives}
          onChange={(learningObjectives) => onChange({ learningObjectives })}
          maxItems={8}
          maxLength={200}
        />

        {authors.length > 0 && (
          <Field label="Author" hint="Attribution shown on the case card.">
            {(p) => (
              <Select
                {...p}
                value={value.authorId}
                onChange={(e) => onChange({ authorId: e.target.value })}
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
        )}
      </Section>

      {/* ── Discussion ─────────────────────────────────────────────────────── */}
      <Section
        title="Discussion & references"
        caption="The teaching narrative around the case, plus further reading."
      >
        <Field
          label="Discussion"
          hint="Pathophysiology, key signs, pitfalls, management — what you'd say on the case."
        >
          {(p) => (
            <Textarea
              {...p}
              rows={5}
              value={value.discussion}
              onChange={(e) => onChange({ discussion: e.target.value })}
              placeholder="Discuss the imaging signs, the differential reasoning, classic pitfalls, and what happens next…"
              maxLength={4000}
            />
          )}
        </Field>

        <RankedList
          label="References"
          caption="Citations, guidelines or links — one per line."
          placeholder="e.g. RadioGraphics 2019;39:1085 — Imaging of acute appendicitis"
          addLabel="Add reference"
          items={value.references}
          onChange={(references) => onChange({ references })}
          maxItems={12}
          maxLength={300}
        />
      </Section>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Building blocks
// ───────────────────────────────────────────────────────────────────────────

function Section({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-primary">{title}</h3>
        <p className="text-xs text-muted">{caption}</p>
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

/**
 * An ordered list editor — used for differentials (ranked), objectives and
 * references. Each row is a real input with add/remove; when `ranked`, up/down
 * controls let the author re-rank (differentials are most→least likely).
 */
function RankedList({
  label,
  caption,
  items,
  onChange,
  placeholder,
  addLabel,
  ranked = false,
  maxItems,
  maxLength,
}: {
  label: string;
  caption?: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  addLabel: string;
  ranked?: boolean;
  maxItems: number;
  maxLength: number;
}) {
  function setAt(i: number, v: string) {
    onChange(items.map((it, idx) => (idx === i ? v : it)));
  }
  function removeAt(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }
  function add() {
    if (items.length >= maxItems) return;
    onChange([...items, ""]);
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-xs font-medium text-secondary">{label}</span>
          {caption && <span className="text-[11px] text-muted">{caption}</span>}
        </div>
        <Button
          size="sm"
          variant="ghost"
          leadingIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={add}
          disabled={items.length >= maxItems}
        >
          {addLabel}
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-strong px-3 py-2.5 text-xs text-muted">
          None yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((it, i) => (
            <li key={i} className="flex items-center gap-2">
              {ranked && (
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-xs font-semibold tabular-nums text-accent">
                  {i + 1}
                </span>
              )}
              <Input
                className="h-9 text-sm"
                value={it}
                placeholder={placeholder}
                aria-label={`${label} ${i + 1}`}
                maxLength={maxLength}
                onChange={(e) => setAt(i, e.target.value)}
              />
              {ranked && (
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    size="sm"
                    aria-label={`Move ${label} ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ChevronUp />
                  </IconButton>
                  <IconButton
                    size="sm"
                    aria-label={`Move ${label} ${i + 1} down`}
                    disabled={i === items.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ChevronDown />
                  </IconButton>
                </div>
              )}
              <IconButton
                size="sm"
                variant="danger"
                aria-label={`Remove ${label} ${i + 1}`}
                onClick={() => removeAt(i)}
              >
                <X className="h-3.5 w-3.5" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Comma/Enter-driven tag chips for teaching tags. */
function TagEditor({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  function addFromInput(raw: string) {
    const parts = raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const merged = [...tags];
    for (const p of parts) if (!merged.includes(p)) merged.push(p);
    onChange(merged);
  }

  return (
    <Field
      label="Teaching tags"
      hint="Press Enter or comma to add (e.g. fracture, incidentaloma, do-not-miss)."
    >
      {(p) => (
        <div className="flex flex-col gap-2">
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t, i) => (
                <Badge key={`${t}-${i}`} variant="neutral" className="gap-1">
                  {t}
                  <button
                    type="button"
                    aria-label={`Remove tag ${t}`}
                    onClick={() => onChange(tags.filter((_, idx) => idx !== i))}
                    className="-mr-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-muted transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <Input
            {...p}
            placeholder="fracture, comparison, do-not-miss"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addFromInput((e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).value = "";
              }
            }}
            onBlur={(e) => {
              addFromInput(e.target.value);
              e.target.value = "";
            }}
          />
        </div>
      )}
    </Field>
  );
}

function ChevronUp() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
      <path d="m18 15-6-6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
      <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
