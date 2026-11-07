// AI-graded structured report — assessment on authored findings.
// The score is never shown without the rubric. Gemini only judges against
// the authored gold lines; it does not invent anatomy.

import type { Finding } from "./types";

export interface ReportRubricItem {
  findingId: string;
  label: string;
  /** Gold report sentence. Grading may not add findings beyond this line. */
  gold: string;
  mustMention: string[];
}

export type ReportVerdict = "hit" | "partial" | "missed" | "wrong";

/** One rubric line compared with the trainee report. */
export interface ReportItemFeedback {
  findingId: string;
  label: string;
  verdict: ReportVerdict;
  /** What was missing or contradicted versus the gold line. Empty on a hit. */
  gap: string;
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
  /** One entry per rubric line, in rubric order. */
  items: ReportItemFeedback[];
  rubric: ReportRubricItem[];
}

export function buildReportRubric(findings: Finding[]): ReportRubricItem[] {
  return findings
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((f) => {
      const authoredGold = f.reportGold?.trim() ?? "";
      const authoredPhrases = (f.reportMustMention ?? [])
        .map((phrase) => phrase.trim())
        .filter(Boolean);
      const description = f.description.trim();
      const points = f.teachingPoints.map((p) => p.trim()).filter(Boolean);
      const useAuthored = Boolean(authoredGold || authoredPhrases.length);
      const gold = authoredGold || description;
      const mustMention = useAuthored
        ? authoredPhrases.length
          ? authoredPhrases
          : [gold].filter(Boolean)
        : [description, ...points].filter(Boolean);
      return {
        findingId: f.id,
        label: f.label.trim() || "Untitled finding",
        gold,
        mustMention,
      };
    });
}

const VERDICTS: ReportVerdict[] = ["hit", "partial", "missed", "wrong"];
const VERDICT_RANK: Record<ReportVerdict, number> = {
  hit: 0,
  partial: 1,
  missed: 2,
  wrong: 3,
};

/** Words a gap may use when they are not in the gold line or the report. */
const GAP_WORDS = new Set(
  `a an the and or of to for in on at as with without from by before after both this that
not no nor is are was were be been being it its your you we our report reports gold missing
missed omit omitted omission wrong incorrect contradicts contradicted required address
addressed addresses line lines says said say saying uses use used using instead about than
versus vs any only does did do has have having when if then also check checked note notes
against trainee impression findings language section technique what which who how into over
under per via each other these those their them there here such same still already requires
require needing need needed should would could must may can will just see comparison reviewed
windows window only covers authored wording graded model available dictate grading`.split(/\s+/)
);

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
  "missed": string[],
  "items": [
    { "findingId": string, "label": string, "verdict": "hit" | "partial" | "missed" | "wrong", "gap": string }
  ]
}
Rules:
- overall is 0–100 and equals the sum of band scores.
- items has exactly one object per rubric entry. Copy findingId and label. Never add a finding.
- hit: the report covers that gold line. gap is "".
- partial: some mustMention phrases are absent. gap names only those missing phrases.
- missed: the gold line is absent. gap quotes the gold line and nothing else.
- wrong: the report contradicts the gold line. gap uses only words from that gold line, its mustMention phrases, or the trainee report.
- Score ONLY against the rubric. Never invent findings, measurements, or diagnoses that are not on the rubric.
- missed[] is the labels of items marked missed or wrong. No other labels.
- comment is one sentence, specific, exam-room tone, and stays inside the rubric and the report.
- modelImpression is 1–3 sentences a good trainee would dictate, using ONLY the gold lines.
- If the report is empty or off-topic, scores are low and comments say so.`;

export function compareReportToGold(
  report: string,
  rubric: ReportRubricItem[]
): ReportItemFeedback[] {
  const haystack = normalizePhrase(report);
  return rubric.map((item) => {
    if (!haystack) return missedItem(item);
    const phrases = item.mustMention.map((phrase) => phrase.trim()).filter(Boolean);
    const missing = phrases.filter((phrase) => !phraseIn(haystack, phrase));
    if (phrases.length === 0 || missing.length === phrases.length) return missedItem(item);
    if (missing.length === 0) {
      return { findingId: item.findingId, label: item.label, verdict: "hit", gap: "" };
    }
    return {
      findingId: item.findingId,
      label: item.label,
      verdict: "partial",
      gap: `Missing: ${missing.join("; ")}.`,
    };
  });
}

/**
 * Offline grade: phrase coverage against the gold lines, plus the rubric.
 * Impression and language stay unscored until the model can read wording.
 */
export function localReportGrade(report: string, rubric: ReportRubricItem[]): ReportGrade {
  const items = compareReportToGold(report, rubric);
  const coverage = items.length
    ? items.reduce((sum, item) => {
        if (item.verdict === "hit") return sum + 1;
        if (item.verdict === "partial") return sum + 0.5;
        return sum;
      }, 0) / items.length
    : 0;
  const findingsScore = Math.round(50 * coverage);
  const gaps = items
    .filter((item) => item.verdict !== "hit")
    .slice(0, 2)
    .map((item) => `${item.label}: ${item.gap}`);
  return normalizeReportGrade(
    {
      overall: findingsScore,
      bands: [
        {
          name: "Findings",
          score: findingsScore,
          max: 50,
          comment: gaps.length
            ? gaps.join(" ")
            : "Covers the authored gold lines.",
        },
        {
          name: "Impression",
          score: 0,
          max: 30,
          comment: "Impression wording is graded when the model is available.",
        },
        {
          name: "Language",
          score: 0,
          max: 20,
          comment: "Report language is graded when the model is available.",
        },
      ],
      modelImpression: rubric
        .map((item) => item.gold.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" "),
      items,
    },
    rubric,
    report
  );
}

export function normalizeReportGrade(
  raw: Partial<ReportGrade> | null | undefined,
  rubric: ReportRubricItem[],
  report?: string
): ReportGrade {
  const bandsIn = Array.isArray(raw?.bands) ? raw!.bands : [];
  const defaults: ReportBand[] = [
    { name: "Findings", score: 0, max: 50, comment: "No grade yet." },
    { name: "Impression", score: 0, max: 30, comment: "No grade yet." },
    { name: "Language", score: 0, max: 20, comment: "No grade yet." },
  ];
  const rubricText = rubric.flatMap((item) => [item.label, item.gold, ...item.mustMention]);
  const commentAllowed = allowedTokens([...rubricText, report ?? ""]);
  const impressionAllowed = allowedTokens(rubricText);
  const bands = defaults.map((d, i) => {
    const src = bandsIn[i];
    const max = d.max;
    const score = clampInt(src?.score, 0, max);
    const comment =
      typeof src?.comment === "string" && src.comment.trim() ? src.comment.trim() : d.comment;
    return {
      name: typeof src?.name === "string" && src.name.trim() ? src.name.trim() : d.name,
      score,
      max,
      comment: citesOnly(comment, commentAllowed)
        ? comment
        : "See the comparison to the gold line.",
    };
  });
  const summed = bands.reduce((n, b) => n + b.score, 0);
  const overall = clampInt(raw?.overall != null ? raw.overall : summed, 0, 100);
  const items = alignItems(raw?.items, rubric, report);
  const goldImpression = rubric
    .map((item) => item.gold.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
  const impression =
    typeof raw?.modelImpression === "string" ? raw.modelImpression.trim() : "";
  return {
    overall,
    bands,
    modelImpression: impression && citesOnly(impression, impressionAllowed) ? impression : goldImpression,
    missed: items
      .filter((item) => item.verdict === "missed" || item.verdict === "wrong")
      .map((item) => item.label),
    items,
    rubric,
  };
}

function alignItems(
  raw: ReportGrade["items"] | undefined,
  rubric: ReportRubricItem[],
  report: string | undefined
): ReportItemFeedback[] {
  const local = report != null ? compareReportToGold(report, rubric) : rubric.map(missedItem);
  const incoming = Array.isArray(raw) ? raw : [];
  return rubric.map((item, index) => {
    const model = incoming.find((entry) => entry?.findingId === item.findingId)
      ?? incoming.find(
        (entry) =>
          typeof entry?.label === "string" &&
          entry.label.trim().toLowerCase() === item.label.toLowerCase()
      );
    return mergeItem(local[index], model, item, report ?? "");
  });
}

function mergeItem(
  local: ReportItemFeedback,
  model: Partial<ReportItemFeedback> | undefined,
  item: ReportRubricItem,
  report: string
): ReportItemFeedback {
  const verdict = model?.verdict;
  if (!isVerdict(verdict)) return local;
  const gap = typeof model?.gap === "string" ? model.gap.trim() : "";
  const allowed = allowedTokens([item.label, item.gold, ...item.mustMention, report]);
  const safe = verdict === "hit" || citesOnly(gap, allowed);
  if (!safe) return local;
  const chosen: ReportVerdict =
    VERDICT_RANK[verdict] >= VERDICT_RANK[local.verdict] ? verdict : local.verdict;
  if (chosen === "hit") {
    return { findingId: item.findingId, label: item.label, verdict: "hit", gap: "" };
  }
  const chosenGap = chosen === verdict && gap ? gap : local.gap;
  return {
    findingId: item.findingId,
    label: item.label,
    verdict: chosen,
    gap: chosenGap || local.gap,
  };
}

function missedItem(item: ReportRubricItem): ReportItemFeedback {
  return {
    findingId: item.findingId,
    label: item.label,
    verdict: "missed",
    gap: item.gold ? `Not in the report. Gold: ${item.gold}` : "Not in the report.",
  };
}

function isVerdict(value: unknown): value is ReportVerdict {
  return typeof value === "string" && (VERDICTS as string[]).includes(value);
}

function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Whole-phrase match so "solid" is not credited inside "subsolid". */
function phraseIn(haystack: string, phrase: string): boolean {
  const needle = normalizePhrase(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!needle) return false;
  return new RegExp(`(?:^|[^a-z0-9])${needle}(?:$|[^a-z0-9])`, "i").test(haystack);
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/-?\d+(?:\.\d+)?|[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
}

function allowedTokens(parts: string[]): Set<string> {
  const allowed = new Set<string>();
  for (const part of parts) {
    for (const token of tokens(part)) allowed.add(token);
  }
  return allowed;
}

function citesOnly(text: string, allowed: Set<string>): boolean {
  if (!text.trim()) return true;
  return tokens(text).every((token) => allowed.has(token) || GAP_WORDS.has(token));
}

function clampInt(n: unknown, min: number, max: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}
