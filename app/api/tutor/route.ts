// POST /api/tutor  — CALL 2 of the student voice Q&A flow (CLAUDE.md §2).
//
// Body:  { caseId, mode, messages: {role,text}[], question?, currentFindingId? }
// Reply: { answer: string, action: TeachingViewerAction }
//
// This runs the TEACHING PLAN: given the case + findings context and the
// student's (already-transcribed) question, Gemini returns the spoken answer
// plus an optional viewer action (show_finding / next_in_tour / prev_in_tour /
// set_window / point_to) that the FRONTEND executes to drive our self-hosted viewer.
//
// Transcription is a SEPARATE call (/api/transcribe) — we never merge them.
// `messages` is the prior chat history; `question` is the current turn (when
// omitted, the last user message is used as the question).

import { NextRequest, NextResponse } from "next/server";
import { geminiConfigured, runTeachingPlan } from "@/lib/gemini";
import { getCase } from "@/lib/cases";
import type { CaseData } from "@/lib/types";

export const runtime = "nodejs";

function findingsContext(data: CaseData): string {
  return data.findings
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((f) => {
      const marker =
        f.marker && Number.isFinite(f.marker.x_pct) && Number.isFinite(f.marker.y_pct)
          ? ` | marker@(${f.marker.x_pct.toFixed(2)},${f.marker.y_pct.toFixed(2)})`
          : "";
      return (
        `- id=${f.id} | order=${f.order} | ${f.label}: ${f.description}` +
        (f.teachingPoints.length ? ` | teaching: ${f.teachingPoints.join("; ")}` : "") +
        marker
      );
    })
    .join("\n");
}

interface InMessage {
  role: "user" | "assistant";
  text: string;
}

export async function POST(req: NextRequest) {
  if (!geminiConfigured()) {
    return NextResponse.json(
      { error: "The AI tutor is unavailable — GEMINI_API_KEY is not set." },
      { status: 503 }
    );
  }

  try {
    const body = await req.json();
    const caseId = String(body.caseId ?? "");
    const mode = (body.mode ?? "guided") as
      | "guided"
      | "socratic"
      | "free"
      | "reporting"
      | "viva";
    const messages = (body.messages ?? []) as InMessage[];
    const currentFindingId = body.currentFindingId
      ? String(body.currentFindingId)
      : undefined;

    const data = await getCase(caseId);
    if (!data) return NextResponse.json({ error: "Case not found" }, { status: 404 });

    // The question is the explicit `question`, else the last user message.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const question =
      typeof body.question === "string" && body.question.trim()
        ? String(body.question)
        : (lastUser?.text ?? "");

    // History = the turns before the current question (so we don't duplicate it).
    const history =
      lastUser && messages[messages.length - 1]?.text === question
        ? messages.slice(0, -1)
        : messages;

    const result = await runTeachingPlan({
      question,
      history,
      caseTitle: data.title,
      modality: data.modality,
      mode,
      findingsContext: findingsContext(data),
      currentFindingId,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
