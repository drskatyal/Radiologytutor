// POST /api/tutor
// Body: { caseId, mode: "guided"|"socratic"|"free", messages: {role,text}[] }
//
// The student-facing AI tutor. Gemini Flash with tool-calling. The model
// decides when to drive the viewer by emitting function calls; the FRONTEND
// executes them (animations are visual side-effects). We pass the full finding
// list in the system instruction so the model can both pick the right tool and
// narrate the finding in the same turn.

import { NextRequest, NextResponse } from "next/server";
import { generate, type FunctionDeclaration, type GeminiContent } from "@/lib/gemini";
import { getCase } from "@/lib/cases";
import type { CaseData } from "@/lib/types";

export const runtime = "nodejs";

const TOOLS: FunctionDeclaration[] = [
  {
    name: "show_finding",
    description:
      "Run the full animated transition to a finding, reveal its marker, and narrate it. Use the finding's id.",
    parameters: {
      type: "object",
      properties: { findingId: { type: "string", description: "Finding id, e.g. f1" } },
      required: ["findingId"],
    },
  },
  {
    name: "set_window",
    description: "Animate a window width/center change on the current slice.",
    parameters: {
      type: "object",
      properties: {
        ww: { type: "number", description: "Window width" },
        wc: { type: "number", description: "Window center" },
      },
      required: ["ww", "wc"],
    },
  },
  {
    name: "compare",
    description: "Set a 2x1 layout and load two findings side by side for comparison.",
    parameters: {
      type: "object",
      properties: {
        findingIdA: { type: "string" },
        findingIdB: { type: "string" },
      },
      required: ["findingIdA", "findingIdB"],
    },
  },
  {
    name: "next_in_tour",
    description: "Advance to the next finding by tour order and narrate it.",
    parameters: { type: "object", properties: {} },
  },
];

function findingsBrief(data: CaseData): string {
  return data.findings
    .slice()
    .sort((a, b) => a.order - b.order)
    .map(
      (f) =>
        `- id=${f.id} | order=${f.order} | ${f.label}: ${f.description}` +
        (f.teachingPoints.length ? ` | teaching: ${f.teachingPoints.join("; ")}` : "")
    )
    .join("\n");
}

function systemPrompt(data: CaseData, mode: string): string {
  const base = `You are a radiology tutor guiding a student through the case "${data.title}" (${data.modality}).
You control a medical image viewer ONLY through these tools: show_finding, set_window, compare, next_in_tour.
You cannot see the images yourself — rely on the finding list below.

Findings (in tour order):
${findingsBrief(data)}

Narration rules:
- When you reveal a finding (show_finding / next_in_tour), narrate its description and teaching points in 1-3 spoken sentences. Warm, concise, exam-room tone.
- Keep text suitable for text-to-speech: no markdown, no bullet symbols, no IDs spoken aloud.
- Call a tool whenever the student should see something. You may call a tool AND provide narration text in the same turn.`;

  if (mode === "socratic") {
    return (
      base +
      `

MODE: SOCRATIC. Do NOT reveal a finding until the student has attempted it. First ask about their search pattern or what they expect to see. Prompt and hint. Only call show_finding after the student has made an attempt or explicitly asks to see the answer.`
    );
  }
  if (mode === "free") {
    return (
      base +
      `

MODE: FREE EXPLORE. The student navigates on their own. Answer their questions. When they ask to see something ("show me the ACL"), match it to a finding and call show_finding. Do not auto-advance.`
    );
  }
  return (
    base +
    `

MODE: GUIDED TOUR. Walk through the findings in order. Start by calling show_finding for the first finding (lowest order) and narrating it. When the student says continue/next, call next_in_tour. Answer questions along the way.`
  );
}

export async function POST(req: NextRequest) {
  try {
    const { caseId, mode = "guided", messages = [], audio } = await req.json();
    const data = await getCase(String(caseId));
    if (!data) return NextResponse.json({ error: "Case not found" }, { status: 404 });

    const contents: GeminiContent[] = (messages as { role: string; text: string }[]).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.text }],
    }));

    // Cold start with no messages: seed an opening instruction.
    if (contents.length === 0) {
      contents.push({ role: "user", parts: [{ text: "Begin the session." }] });
    }

    // Voice turn: Gemini does STT. Attach the audio to the final user turn so
    // the model hears the spoken question directly.
    if (audio?.base64) {
      let lastUser = [...contents].reverse().find((c) => c.role === "user");
      if (!lastUser) {
        lastUser = { role: "user", parts: [] };
        contents.push(lastUser);
      }
      lastUser.parts.unshift({
        inlineData: { mimeType: audio.mime || "audio/webm", data: audio.base64 },
      });
    }

    const result = await generate({
      systemInstruction: systemPrompt(data, String(mode)),
      temperature: 0.4,
      tools: TOOLS,
      contents,
    });

    return NextResponse.json({
      text: result.text,
      functionCalls: result.functionCalls,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
