// Validation for a teacher-authored course post-test (Studio → Courses).
//
// Pure: the route hands in the course's cases and their findings, and gets
// back either a clean question list or every problem in plain words. Answer
// keys the client cannot be trusted with are resolved here, server-side:
//   - a click-the-finding target is the finding's AUTHORED marker, never a
//     point the client posts;
//   - question ids are stable when supplied (so attempts keep matching) and
//     minted otherwise.

import { DEFAULT_HIT_RADIUS } from "./clickFinding";
import type { Marker, Question } from "./types";

export const MCQ_MIN_OPTIONS = 2;
export const MCQ_MAX_OPTIONS = 6;
export const MAX_QUESTIONS = 30;
export const MIN_HIT_RADIUS = 0.03;
export const MAX_HIT_RADIUS = 0.25;
const MAX_PROMPT = 600;
const MAX_OPTION = 300;
const MAX_RATIONALE = 1200;

export type AssessmentDraftQuestion =
  | {
      id?: string;
      kind: "mcq";
      prompt: string;
      options: string[];
      correctIndex: number;
      rationale?: string;
    }
  | {
      id?: string;
      kind: "click_finding";
      prompt: string;
      caseId: string;
      findingId: string;
      toleranceRadiusPct?: number;
    }
  | {
      id?: string;
      kind: "report";
      prompt: string;
      caseId: string;
      findingIds?: string[];
      passMark?: number;
    };

export interface AssessmentDraft {
  title: string;
  description?: string;
  passingScore: number;
  questions: AssessmentDraftQuestion[];
}

/** What the validator needs to know about one of the course's cases. */
export interface DraftCaseContext {
  caseId: string;
  title: string;
  findings: Array<{ id: string; label: string; marker?: Marker | null }>;
}

export interface CleanAssessment {
  title: string;
  description?: string;
  passingScore: number;
  questions: Question[];
}

export type DraftResult =
  | { ok: true; value: CleanAssessment }
  | { ok: false; errors: string[] };

export function validateAssessmentDraft(
  raw: unknown,
  cases: DraftCaseContext[],
  mintId: () => string
): DraftResult {
  const errors: string[] = [];
  const draft = (raw ?? {}) as Partial<AssessmentDraft>;
  const title = str(draft.title).slice(0, 200);
  if (!title) errors.push("Give the post-test a title.");
  const description = str(draft.description).slice(0, 1000) || undefined;
  const passingScore = Number(draft.passingScore);
  if (!Number.isFinite(passingScore) || passingScore < 1 || passingScore > 100) {
    errors.push("Passing score must be between 1 and 100.");
  }

  const list = Array.isArray(draft.questions) ? draft.questions : [];
  if (list.length === 0) errors.push("Add at least one question.");
  if (list.length > MAX_QUESTIONS) errors.push(`A post-test has at most ${MAX_QUESTIONS} questions.`);

  const byCase = new Map(cases.map((c) => [c.caseId, c]));
  const seenIds = new Set<string>();
  const questions: Question[] = [];

  list.slice(0, MAX_QUESTIONS).forEach((q, index) => {
    const n = `Question ${index + 1}`;
    const item = (q ?? {}) as Partial<AssessmentDraftQuestion> & Record<string, unknown>;
    const prompt = str(item.prompt).slice(0, MAX_PROMPT);
    if (!prompt) errors.push(`${n}: write the question.`);
    let id = safeQuestionId(item.id);
    if (!id || seenIds.has(id)) id = mintId();
    seenIds.add(id);

    if (item.kind === "mcq") {
      const options = (Array.isArray(item.options) ? item.options : [])
        .map((o) => str(o).slice(0, MAX_OPTION));
      if (options.length < MCQ_MIN_OPTIONS || options.length > MCQ_MAX_OPTIONS) {
        errors.push(`${n}: give ${MCQ_MIN_OPTIONS}–${MCQ_MAX_OPTIONS} options.`);
      }
      if (options.some((o) => !o)) errors.push(`${n}: an option is empty.`);
      const lowered = options.map((o) => o.toLowerCase()).filter(Boolean);
      if (new Set(lowered).size !== lowered.length) errors.push(`${n}: two options are the same.`);
      const correctIndex = Number(item.correctIndex);
      if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
        errors.push(`${n}: mark the correct option.`);
      }
      const rationale = str(item.rationale).slice(0, MAX_RATIONALE) || undefined;
      questions.push({ id, kind: "mcq", prompt, options, correctIndex, rationale });
      return;
    }

    if (item.kind === "click_finding") {
      const caseId = str(item.caseId);
      const ctx = byCase.get(caseId);
      if (!ctx) {
        errors.push(`${n}: pick a case from this course.`);
        return;
      }
      const findingId = str(item.findingId);
      const finding = ctx.findings.find((f) => f.id === findingId);
      if (!finding) {
        errors.push(`${n}: pick a finding on "${ctx.title}".`);
        return;
      }
      if (!validMarker(finding.marker)) {
        errors.push(
          `${n}: "${finding.label || "This finding"}" has no marker yet — place one in the case editor first.`
        );
        return;
      }
      const radiusIn = item.toleranceRadiusPct;
      const radius =
        typeof radiusIn === "number" && Number.isFinite(radiusIn)
          ? Math.min(MAX_HIT_RADIUS, Math.max(MIN_HIT_RADIUS, radiusIn))
          : DEFAULT_HIT_RADIUS;
      questions.push({
        id,
        kind: "click_finding",
        prompt,
        caseId,
        findingId,
        targetMarker: {
          x_pct: finding.marker.x_pct,
          y_pct: finding.marker.y_pct,
          shape: finding.marker.shape,
        },
        toleranceRadiusPct: radius,
      });
      return;
    }

    if (item.kind === "report") {
      const caseId = str(item.caseId);
      const ctx = byCase.get(caseId);
      if (!ctx) {
        errors.push(`${n}: pick a case from this course.`);
        return;
      }
      if (ctx.findings.length === 0) {
        errors.push(`${n}: "${ctx.title}" has no findings to grade a report against.`);
        return;
      }
      const known = new Set(ctx.findings.map((f) => f.id));
      const requested = Array.isArray(item.findingIds) ? item.findingIds.map(str).filter(Boolean) : [];
      const findingIds = requested.filter((fid) => known.has(fid));
      if (requested.length > findingIds.length) {
        errors.push(`${n}: a selected finding is no longer on "${ctx.title}".`);
      }
      const passMarkIn = Number(item.passMark);
      const passMark = Number.isFinite(passMarkIn)
        ? Math.min(100, Math.max(0, Math.round(passMarkIn)))
        : undefined;
      questions.push({
        id,
        kind: "report",
        prompt,
        caseId,
        ...(findingIds.length ? { findingIds } : {}),
        ...(passMark !== undefined ? { passMark } : {}),
      });
      return;
    }

    errors.push(`${n}: unknown question type.`);
  });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { title, description, passingScore: Math.round(passingScore), questions },
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function safeQuestionId(v: unknown): string {
  const s = str(v);
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : "";
}

function validMarker(m: Marker | null | undefined): m is Marker {
  return Boolean(
    m &&
      Number.isFinite(m.x_pct) &&
      Number.isFinite(m.y_pct) &&
      m.x_pct >= 0 &&
      m.x_pct <= 1 &&
      m.y_pct >= 0 &&
      m.y_pct <= 1
  );
}
