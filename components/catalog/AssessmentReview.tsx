"use client";

// Post-submit review of a post-test attempt, one row per question.
//
// What a learner sees comes from lib/assessmentGrade `reviewAttempt`: the
// correct option and the click target only on a passed attempt, and a report
// question's full rubric always — an AI score is never shown bare.

import { useState } from "react";
import { CheckCircle2, ChevronDown, CircleDot, XCircle } from "lucide-react";
import { Badge, Button, cn } from "@/components/ui";
import { LocateStage } from "./LocateStage";
import type { AttemptReview, QuestionReview } from "@/lib/assessmentGrade";
import type { AttemptReportGrade } from "@/lib/types";

export type ReviewQuestion = {
  id: string;
  kind: "mcq" | "click_finding" | "report";
  prompt: string;
  options?: string[];
};

export function AssessmentReview({
  courseId,
  questions,
  review,
}: {
  courseId: string;
  questions: ReviewQuestion[];
  review: AttemptReview;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(review.questions.map((q) => [q.questionId, q]));

  return (
    <div className="space-y-2">
      {!review.keysRevealed && (
        <p className="text-xs text-muted">
          Correct answers and finding locations appear once you pass. Report rubrics are always
          shown.
        </p>
      )}
      <ol className="space-y-2">
        {questions.map((q, i) => {
          const r = byId.get(q.id);
          const expanded = open === q.id;
          const panelId = `review-${q.id}`;
          return (
            <li key={q.id} className="rounded-lg border border-subtle bg-elevated">
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : q.id)}
                aria-expanded={expanded}
                aria-controls={panelId}
                className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <ResultIcon review={r} />
                <span className="min-w-0 flex-1 text-secondary">
                  <span className="text-muted tabular-nums">Q{i + 1}. </span>
                  <span className="text-primary">{q.prompt}</span>
                </span>
                {r?.kind === "report" && (
                  <Badge
                    variant={r.correct ? "success" : "warning"}
                    className="shrink-0 tabular-nums"
                  >
                    {r.grade ? `${r.grade.overall}/100` : "Not graded"}
                  </Badge>
                )}
                <ChevronDown
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0 text-muted transition-transform",
                    expanded && "rotate-180"
                  )}
                  aria-hidden="true"
                />
              </button>
              {expanded && r && (
                <div id={panelId} className="border-t border-subtle px-3 pb-3 pt-3">
                  <ReviewDetail courseId={courseId} question={q} review={r} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ResultIcon({ review }: { review?: QuestionReview }) {
  if (review?.correct) {
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Correct" />;
  }
  if (review?.kind === "report" && review.credit > 0) {
    return <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-label="Partial credit" />;
  }
  return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="Incorrect" />;
}

function ReviewDetail({
  courseId,
  question,
  review,
}: {
  courseId: string;
  question: ReviewQuestion;
  review: QuestionReview;
}) {
  if (review.kind === "mcq") {
    return (
      <div className="space-y-2">
        <ul className="space-y-1.5">
          {(question.options ?? []).map((opt, idx) => {
            const chosen = review.selectedIndex === idx;
            const isKey = review.correctIndex === idx;
            return (
              <li
                key={idx}
                className={cn(
                  "flex items-start gap-2.5 rounded-md border px-2.5 py-2 text-sm",
                  isKey
                    ? "border-success/40 bg-success/5 text-primary"
                    : chosen
                      ? review.correct
                        ? "border-success/40 bg-success/5 text-primary"
                        : "border-danger/40 bg-danger/5 text-primary"
                      : "border-subtle text-secondary"
                )}
              >
                <span className="mt-px text-xs font-semibold tabular-nums text-muted">
                  {String.fromCharCode(65 + idx)}
                </span>
                <span className="flex-1">{opt}</span>
                {chosen && <Badge variant="neutral">Your answer</Badge>}
                {isKey && <Badge variant="success">Correct</Badge>}
              </li>
            );
          })}
        </ul>
        {review.rationale && (
          <p className="text-sm text-secondary">
            <span className="font-medium text-primary">Why. </span>
            {review.rationale}
          </p>
        )}
      </div>
    );
  }

  if (review.kind === "click_finding") {
    const placed =
      review.x_pct !== undefined && review.y_pct !== undefined
        ? { x_pct: review.x_pct, y_pct: review.y_pct }
        : undefined;
    return (
      <div className="space-y-2">
        <p className="text-sm text-secondary">
          {placed
            ? review.correct
              ? "Your mark landed on the finding."
              : "Your mark missed the finding."
            : "No mark was placed."}
          {review.distance !== undefined && review.toleranceRadiusPct !== undefined && (
            <span className="tabular-nums text-muted">
              {" "}
              Distance {Math.round(review.distance * 100)}% of the image (hit within{" "}
              {Math.round(review.toleranceRadiusPct * 100)}%).
            </span>
          )}
        </p>
        <LocateStage
          courseId={courseId}
          questionId={question.id}
          mode="review"
          answer={placed}
          target={
            review.target
              ? {
                  x_pct: review.target.x_pct,
                  y_pct: review.target.y_pct,
                  radius: review.toleranceRadiusPct ?? 0.08,
                }
              : undefined
          }
        />
      </div>
    );
  }

  return <ReportReview text={review.text} grade={review.grade} />;
}

function ReportReview({ text, grade }: { text: string; grade?: AttemptReportGrade }) {
  const [showReport, setShowReport] = useState(false);
  if (!grade) {
    return (
      <p className="text-sm text-secondary">
        This report could not be graded — the case for this question is unavailable. It earned no
        credit; ask your course author to check the case.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={grade.overall >= grade.passMark ? "success" : "warning"} className="tabular-nums">
          {grade.overall}/100 · pass ≥ {grade.passMark}
        </Badge>
        <span className="text-xs text-muted">
          {grade.gradedBy === "model"
            ? "AI-graded against the rubric below."
            : "AI grader unavailable — scored on rubric findings coverage only, scaled to 100."}
        </span>
      </div>

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Rubric</p>
        <ul className="mt-1.5 space-y-1.5">
          {grade.items.map((item) => {
            const row = grade.rubric.find((r) => r.findingId === item.findingId);
            return (
              <li
                key={item.findingId}
                className="rounded-md border border-subtle bg-surface px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-primary">{item.label}</p>
                  <Badge variant={verdictVariant(item.verdict)}>{verdictLabel(item.verdict)}</Badge>
                </div>
                {row?.gold && (
                  <p className="mt-0.5 text-[11px] leading-snug text-secondary">Gold: {row.gold}</p>
                )}
                {item.gap && !(row?.gold && item.gap.includes(row.gold)) && (
                  <p className="mt-0.5 text-[11px] leading-snug text-muted">{item.gap}</p>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <ul className="grid gap-2 sm:grid-cols-3">
        {grade.bands.map((b) => (
          <li key={b.name} className="rounded-md border border-subtle bg-surface px-2.5 py-2">
            <p className="text-xs font-medium text-primary">
              {b.name}{" "}
              <span className="tabular-nums text-muted">
                {b.score}/{b.max}
              </span>
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-secondary">{b.comment}</p>
          </li>
        ))}
      </ul>

      {grade.modelImpression && (
        <p className="text-sm text-secondary">
          <span className="font-medium text-primary">Model impression. </span>
          {grade.modelImpression}
        </p>
      )}

      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowReport((v) => !v)}
          aria-expanded={showReport}
        >
          {showReport ? "Hide your report" : "Show your report"}
        </Button>
        {showReport && (
          <p className="mt-1 whitespace-pre-wrap rounded-md border border-subtle bg-surface px-2.5 py-2 text-sm text-secondary">
            {text || "No report was written."}
          </p>
        )}
      </div>
    </div>
  );
}

function verdictLabel(verdict: AttemptReportGrade["items"][number]["verdict"]): string {
  if (verdict === "hit") return "Covered";
  if (verdict === "partial") return "Incomplete";
  if (verdict === "wrong") return "Contradicts";
  return "Missing";
}

function verdictVariant(
  verdict: AttemptReportGrade["items"][number]["verdict"]
): "success" | "warning" | "danger" {
  if (verdict === "hit") return "success";
  if (verdict === "partial") return "warning";
  return "danger";
}
