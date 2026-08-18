"use client";

// Report coach — Technique / Findings / Impression with rubric always visible.
// "Model this" asks the attending tutor (viewer + speech) to demonstrate the
// section; Grade scores the registrar's attempt against authored findings only.

import { useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Spinner,
  Tabs,
  Textarea,
  useToast,
} from "@/components/ui";
import type { Finding } from "@/lib/types";
import {
  buildReportRubric,
  type ReportGrade,
} from "@/lib/reportGrade";

type Section = "technique" | "findings" | "impression";

const SECTION_HINT: Record<Section, string> = {
  technique:
    "Model a Technique line for this study (modality, sequences, contrast) in report language — one or two sentences. Do not invent findings.",
  findings:
    "Walk Findings in tour order. For each authored finding, drive the viewer (show_finding / set_window / point_to) and dictate how a registrar should report it. Short spoken sentences.",
  impression:
    "Model a concise Impression from the authored findings only, numbered in speech. Then invite the registrar to try dictating their own.",
};

export function ReportCoach({
  caseId,
  findings,
  onAskTutor,
  compact = false,
}: {
  caseId: string;
  findings: Finding[];
  /** Send a coaching prompt to the live tutor (drives viewer + speech). */
  onAskTutor?: (text: string) => void;
  compact?: boolean;
}) {
  const { toast } = useToast();
  const rubric = buildReportRubric(findings);
  const [section, setSection] = useState<Section>("findings");
  const [technique, setTechnique] = useState("");
  const [findingsText, setFindingsText] = useState("");
  const [impression, setImpression] = useState("");
  const [busy, setBusy] = useState(false);
  const [grade, setGrade] = useState<ReportGrade | null>(null);

  const reportBody = [
    technique.trim() && `Technique:\n${technique.trim()}`,
    findingsText.trim() && `Findings:\n${findingsText.trim()}`,
    impression.trim() && `Impression:\n${impression.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  async function onGrade() {
    if (busy) return;
    if (!reportBody.trim()) {
      toast({
        title: "Nothing to grade",
        description: "Write or dictate at least one section first.",
        variant: "warning",
      });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/grade-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, report: reportBody }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.grade) setGrade(data.grade as ReportGrade);
        throw new Error(data.error || "Grader unavailable");
      }
      setGrade(data as ReportGrade);
    } catch (e) {
      toast({
        title: "Couldn't grade report",
        description: e instanceof Error ? e.message : undefined,
        variant: "danger",
      });
    } finally {
      setBusy(false);
    }
  }

  function modelSection() {
    onAskTutor?.(SECTION_HINT[section]);
  }

  if (findings.length === 0) {
    return (
      <EmptyState
        title="No findings to report"
        description="This case has no authored findings, so there is nothing to grade against."
      />
    );
  }

  const value =
    section === "technique"
      ? technique
      : section === "findings"
        ? findingsText
        : impression;
  const setValue =
    section === "technique"
      ? setTechnique
      : section === "findings"
        ? setFindingsText
        : setImpression;

  return (
    <div
      className={
        compact
          ? "flex flex-col gap-3 border-b border-subtle p-3"
          : "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
      }
    >
      <div>
        <h3 className="text-sm font-semibold text-primary">Practice the report</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Watch the attending model each section on the viewer, then write your
          own. Grades only use authored findings — never a bare score.
        </p>
      </div>

      <Tabs
        items={[
          { value: "technique", label: "Technique" },
          { value: "findings", label: "Findings" },
          { value: "impression", label: "Impression" },
        ]}
        value={section}
        onValueChange={(v) => setSection(v as Section)}
      />

      <div className="flex flex-wrap gap-2">
        {onAskTutor && (
          <Button size="sm" variant="secondary" onClick={modelSection}>
            Model this section
          </Button>
        )}
        <Button size="sm" onClick={onGrade} disabled={busy} loading={busy}>
          {busy ? "Grading…" : "Grade report"}
        </Button>
      </div>

      <Field label={`Your ${section}`}>
        {(p) => (
          <Textarea
            {...p}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={compact ? 4 : 6}
            placeholder={
              section === "technique"
                ? "Technique: …"
                : section === "findings"
                  ? "Findings: …"
                  : "Impression: …"
            }
          />
        )}
      </Field>

      {!compact && (
        <ul className="flex flex-col gap-1.5">
          <li className="text-[10px] font-semibold uppercase tracking-wide text-muted">
            Rubric
          </li>
          {rubric.map((item, i) => (
            <li
              key={item.findingId}
              className="rounded-lg border border-subtle bg-elevated px-2.5 py-2"
            >
              <p className="text-xs font-medium text-primary">
                <span className="tabular-nums text-muted">{i + 1}.</span> {item.label}
              </p>
              {item.mustMention.length > 0 && (
                <p className="mt-0.5 text-[11px] leading-snug text-secondary">
                  {item.mustMention.join(" · ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {busy && !grade && (
        <div className="flex items-center gap-2 text-xs text-secondary">
          <Spinner size="sm" label="Grading report" />
          Comparing against the rubric…
        </div>
      )}

      {grade && (
        <div className="rounded-lg border border-subtle bg-surface p-3">
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="accent" className="tabular-nums">
              {grade.overall}/100
            </Badge>
            <span className="text-xs text-muted">Against authored rubric</span>
          </div>
          <ul className="flex flex-col gap-2">
            {grade.bands.map((b) => (
              <li key={b.name}>
                <p className="text-xs font-medium text-primary">
                  {b.name}{" "}
                  <span className="tabular-nums text-muted">
                    {b.score}/{b.max}
                  </span>
                </p>
                <p className="text-[11px] leading-snug text-secondary">{b.comment}</p>
              </li>
            ))}
          </ul>
          {grade.missed.length > 0 && (
            <p className="mt-2 text-[11px] text-warning">
              Missed: {grade.missed.join(", ")}
            </p>
          )}
          {grade.modelImpression && (
            <p className="mt-2 text-[11px] leading-snug text-secondary">
              <span className="font-medium text-primary">Model impression. </span>
              {grade.modelImpression}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
