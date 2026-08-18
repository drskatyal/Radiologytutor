"use client";

// Structured-report coach. Rubric is always visible. The AI score is never
// shown without the bands and the authored must-mention list.

import { useState } from "react";
import { Badge, Button, EmptyState, Field, Spinner, Textarea, useToast } from "@/components/ui";
import type { Finding } from "@/lib/types";
import {
  buildReportRubric,
  type ReportGrade,
} from "@/lib/reportGrade";

export function ReportCoach({
  caseId,
  findings,
}: {
  caseId: string;
  findings: Finding[];
}) {
  const { toast } = useToast();
  const rubric = buildReportRubric(findings);
  const [report, setReport] = useState("");
  const [busy, setBusy] = useState(false);
  const [grade, setGrade] = useState<ReportGrade | null>(null);

  async function onGrade() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/grade-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, report }),
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

  if (findings.length === 0) {
    return (
      <EmptyState
        title="No findings to report"
        description="This case has no authored findings, so there is nothing to grade against."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div>
        <h3 className="text-sm font-semibold text-primary">Report against the rubric</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Dictate or type Technique / Findings / Impression. The grade is only
          against what was authored — never a bare score.
        </p>
      </div>

      <ul className="flex flex-col gap-1.5">
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

      <Field label="Your report">
        {(p) => (
          <Textarea
            {...p}
            value={report}
            onChange={(e) => setReport(e.target.value)}
            rows={6}
            placeholder="Technique: …&#10;Findings: …&#10;Impression: …"
          />
        )}
      </Field>

      <Button onClick={onGrade} disabled={busy} loading={busy}>
        {busy ? "Grading…" : "Grade report"}
      </Button>

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
