"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, XCircle } from "lucide-react";
import { Badge, Button, useToast } from "@/components/ui";
import { LocateStage } from "./LocateStage";
import type { Attempt } from "@/lib/types";
import type { LearnerAnswer } from "@/lib/assessmentGrade";

type PublicQ = {
  id: string;
  kind: "mcq" | "click_finding" | "report";
  prompt: string;
  options?: string[];
  caseId?: string;
  findingId?: string;
};

type PublicAssessment = {
  id: string;
  title: string;
  description?: string;
  passingScore: number;
  questions: PublicQ[];
};

export function CourseAssessment({
  courseId,
  assessment,
  initialBestAttempt,
  isEnrolled,
}: {
  courseId: string;
  assessment: PublicAssessment;
  initialBestAttempt?: Attempt | null;
  isEnrolled: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, LearnerAnswer>>({});
  const [bestAttempt, setBestAttempt] = useState(initialBestAttempt ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<Attempt | null>(null);

  const questions = assessment.questions;
  const current = questions[step];
  const isLast = step >= questions.length - 1;

  function setMcq(questionId: string, selectedIndex: number) {
    setAnswers((prev) => ({
      ...prev,
      [questionId]: { questionId, selectedIndex },
    }));
  }

  // LocateStage hands back a point already normalized against the viewport,
  // which is the same [0,1] space the author's marker was stored in.
  const setLocate = useCallback((questionId: string, x_pct: number, y_pct: number) => {
    setAnswers((prev) => ({
      ...prev,
      [questionId]: { questionId, x_pct, y_pct },
    }));
  }, []);

  async function submit() {
    setSubmitting(true);
    try {
      const payload: LearnerAnswer[] = questions.map((q) => {
        const a = answers[q.id];
        return a ?? { questionId: q.id };
      });
      const res = await fetch("/api/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assessmentId: assessment.id, answers: payload }),
      });
      if (res.status === 401) {
        router.push(`/sign-in?next=/course/${encodeURIComponent(courseId)}`);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        attempt?: Attempt;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      const attempt = data.attempt!;
      setLastResult(attempt);
      if (!bestAttempt || attempt.score >= bestAttempt.score) {
        setBestAttempt(attempt);
      }
      toast({
        title: attempt.passed ? "Assessment passed" : "Assessment submitted",
        description: `Score ${attempt.score}% (pass ≥ ${assessment.passingScore}%).`,
        variant: attempt.passed ? "success" : "warning",
      });
      router.refresh();
    } catch (e) {
      toast({
        title: "Could not submit assessment",
        description: (e as Error).message,
        variant: "danger",
      });
    } finally {
      setSubmitting(false);
    }
  }

  function nextOrSubmit() {
    if (!current) return;
    const answered = answers[current.id];
    const hasAnswer =
      current.kind === "mcq"
        ? answered?.selectedIndex !== undefined
        : current.kind === "click_finding"
          ? answered?.x_pct !== undefined
          : false;
    if (!hasAnswer) {
      toast({
        title: "Answer required",
        description: "Select an option or click the image before continuing.",
        variant: "warning",
      });
      return;
    }
    if (isLast) void submit();
    else setStep((s) => s + 1);
  }

  const clickAnswer = current?.kind === "click_finding" ? answers[current.id] : undefined;

  return (
    <div className="rounded-xl border border-subtle bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-base font-semibold text-primary">
            {assessment.title}
          </h3>
          {assessment.description && (
            <p className="mt-1 max-w-2xl text-sm text-secondary">{assessment.description}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="neutral" className="tabular-nums">
            Pass ≥ {assessment.passingScore}%
          </Badge>
          {bestAttempt && (
            <Badge variant={bestAttempt.passed ? "success" : "warning"} className="tabular-nums">
              Best {bestAttempt.score}%
              {bestAttempt.passed ? " · Passed" : ""}
            </Badge>
          )}
        </div>
      </div>

      {!isEnrolled ? (
        <p className="mt-4 text-sm text-secondary">
          Enroll in this course to take the post-test and unlock your certificate.
        </p>
      ) : lastResult ? (
        <div className="mt-5 space-y-4">
          <div
            className={`flex items-start gap-3 rounded-lg border p-4 ${
              lastResult.passed
                ? "border-success/30 bg-success/5"
                : "border-warning/30 bg-warning/5"
            }`}
          >
            {lastResult.passed ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
            ) : (
              <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
            )}
            <div>
              <p className="font-medium text-primary">
                {lastResult.passed ? "You passed the post-test" : "Not quite — try again"}
              </p>
              <p className="mt-1 text-sm text-secondary tabular-nums">
                Score {lastResult.score}% · {lastResult.responses.filter((r) => r.correct).length} of{" "}
                {lastResult.responses.length} correct
              </p>
            </div>
          </div>
          <ul className="space-y-2">
            {questions.map((q, i) => {
              const r = lastResult.responses.find((x) => x.questionId === q.id);
              return (
                <li
                  key={q.id}
                  className="flex items-start gap-2 text-sm text-secondary"
                >
                  {r?.correct ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
                  )}
                  <span>
                    <span className="text-muted tabular-nums">Q{i + 1}. </span>
                    {q.prompt}
                  </span>
                </li>
              );
            })}
          </ul>
          {!lastResult.passed && (
            <Button
              variant="secondary"
              onClick={() => {
                setLastResult(null);
                setStep(0);
                setAnswers({});
              }}
            >
              Retake assessment
            </Button>
          )}
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted tabular-nums">
            Question {step + 1} of {questions.length}
          </p>
          {current && (
            <>
              <p className="text-sm font-medium text-primary">{current.prompt}</p>

              {current.kind === "mcq" && current.options && (
                <fieldset className="space-y-2">
                  <legend className="sr-only">Choose one answer</legend>
                  {current.options.map((opt, idx) => {
                    const selected = answers[current.id]?.selectedIndex === idx;
                    return (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setMcq(current.id, idx)}
                        className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                          selected
                            ? "border-accent bg-accent/10 text-primary"
                            : "border-subtle bg-elevated text-secondary hover:border-strong hover:text-primary"
                        }`}
                        aria-pressed={selected}
                      >
                        <span
                          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums ${
                            selected
                              ? "border-accent bg-accent text-accent-foreground"
                              : "border-strong text-muted"
                          }`}
                          aria-hidden="true"
                        >
                          {String.fromCharCode(65 + idx)}
                        </span>
                        {opt}
                      </button>
                    );
                  })}
                </fieldset>
              )}

              {current.kind === "click_finding" && (
                <LocateStage
                  courseId={courseId}
                  questionId={current.id}
                  answer={clickAnswer}
                  onLocate={(x, y) => setLocate(current.id, x, y)}
                />
              )}
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <Button
              variant="ghost"
              disabled={step === 0 || submitting}
              onClick={() => setStep((s) => Math.max(0, s - 1))}
            >
              Back
            </Button>
            <Button onClick={nextOrSubmit} loading={submitting}>
              {isLast ? "Submit assessment" : "Next"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
