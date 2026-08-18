// AI-graded structured report — assessment on authored findings.
// The score is never shown without the rubric. Gemini only judges against
// the authored list; it does not invent anatomy.

import type { Finding } from "./types";

export interface ReportRubricItem {
  findingId: string;
  label: string;
  mustMention: string[];
}

export interface ReportBand {
  name: string;
  score: number;
  max: number;
  comment: string;
}

export interface ReportGrade {
  overall: number;
  bands: ReportBand[];
  modelImpression: string;
  missed: string[];
  rubric: ReportRubricItem[];
}

export function buildReportRubric(findings: Finding[]): ReportRubricItem[] {
  return findings
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((f) => ({
      findingId: f.id,
      label: f.label.trim() || "Untitled finding",
      mustMention: [
        f.description.trim(),
        ...f.teachingPoints.map((p) => p.trim()).filter(Boolean),
      ].filter(Boolean),
    }));
}

export const GRADE_REPORT_SYSTEM = `You grade a radiology trainee's structured report against an authored rubric.
Return ONLY JSON — no prose, no markdown — with EXACTLY:
{
  "overall": number,
  "bands": [
    { "name": "Findings", "score": number, "max": 50, "comment": string },
    { "name": "Impression", "score": number, "max": 30, "comment": string },
    { "name": "Language", "score": number, "max": 20, "comment": string }
  ],
  "modelImpression": string,
  "missed": string[]
}
Rules:
- overall is 0–100 and equals the sum of band scores.
- Score ONLY against the rubric. Never invent findings, measurements, or diagnoses that are not on the rubric.
- missed[] lists rubric labels the report omitted or got wrong.
- comment is one sentence, specific, exam-room tone.
- modelImpression is 1–3 sentences a good trainee would dictate, using ONLY rubric evidence.
- If the report is empty or off-topic, scores are low and comments say so.`;

export function normalizeReportGrade(
  raw: Partial<ReportGrade> | null | undefined,
  rubric: ReportRubricItem[]
): ReportGrade {
  const bandsIn = Array.isArray(raw?.bands) ? raw!.bands : [];
  const defaults: ReportBand[] = [
    { name: "Findings", score: 0, max: 50, comment: "No grade yet." },
    { name: "Impression", score: 0, max: 30, comment: "No grade yet." },
    { name: "Language", score: 0, max: 20, comment: "No grade yet." },
  ];
  const bands = defaults.map((d, i) => {
    const src = bandsIn[i];
    const max = d.max;
    const score = clampInt(src?.score, 0, max);
    return {
      name: typeof src?.name === "string" && src.name.trim() ? src.name.trim() : d.name,
      score,
      max,
      comment:
        typeof src?.comment === "string" && src.comment.trim()
          ? src.comment.trim()
          : d.comment,
    };
  });
  const summed = bands.reduce((n, b) => n + b.score, 0);
  const overall = clampInt(
    raw?.overall != null ? raw.overall : summed,
    0,
    100
  );
  return {
    overall,
    bands,
    modelImpression:
      typeof raw?.modelImpression === "string" ? raw.modelImpression.trim() : "",
    missed: Array.isArray(raw?.missed)
      ? raw!.missed.filter((m): m is string => typeof m === "string" && !!m.trim())
      : [],
    rubric,
  };
}

function clampInt(n: unknown, min: number, max: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}
