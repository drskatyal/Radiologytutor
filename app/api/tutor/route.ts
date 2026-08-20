// POST /api/tutor  — CALL 2 of the student voice Q&A flow (CLAUDE.md §2).
//
// Body:  { caseId, mode, messages: {role,text}[], question?, currentFindingId? }
// Reply: { answer: string, action: TeachingViewerAction, actions: TeachingViewerAction[] }
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
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import { canAccessOrgResource } from "@/lib/authRoles";
import { geminiConfigured, runTeachingPlan } from "@/lib/gemini";
import { getCaseForOrg } from "@/lib/cases";
import { formatFindingsContextFromCase } from "@/lib/teachingPrompt";

export const runtime = "nodejs";


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
    // The tutor prompt carries the case's full teaching text (diagnosis,
    // findings, teaching points), so this is a content read: it must be
    // authenticated, org-scoped, and draft-gated exactly like GET /api/cases/[id].
    const user = await requireSession();
    const orgId = await activeOrgId();

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

    const data = await getCaseForOrg(orgId, caseId);
    if (!data) return NextResponse.json({ error: "Case not found" }, { status: 404 });

    if (data.status !== "published") {
      const canSeeDraft = canAccessOrgResource({
        platformRole: user.platformRole,
        membershipRole: user.membershipRole,
        need: "author",
      });
      if (!canSeeDraft) {
        return NextResponse.json({ error: "Case not found" }, { status: 404 });
      }
    }

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
      findingsContext: formatFindingsContextFromCase(data),
      currentFindingId,
    });

    return NextResponse.json(result);
  } catch (err) {
    const authErr = jsonAuthError(err);
    if (authErr) return authErr;
    // Upstream provider errors can echo request detail — log server-side, and
    // hand the client a generic message.
    console.error("[api/tutor]", err);
    return NextResponse.json({ error: "The tutor is unavailable right now." }, { status: 502 });
  }
}
