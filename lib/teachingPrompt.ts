// Server-side teaching copy. Kept out of UI so we can test the examiner
// contract: short turns, authored evidence only, no invented coordinates.

import { secondaryAnchor } from "./findingAnchors";
import { formatMeasurementBrief } from "./findingMeasurements";
import { formatFindingReadingContext } from "./readingDigest";
import { formatTeachingGuideLine, resolveTeachingGuide } from "./teachingGuide";
import type { CaseData, Finding } from "./types";

export type TeachingMode = "guided" | "socratic" | "free" | "reporting" | "viva";

export interface TeachingPromptInput {
  caseTitle: string;
  modality: string;
  mode: TeachingMode;
  findingsContext: string;
  currentFindingId?: string;
  /**
   * Socratic / viva rung for this turn. 0 look-cue, 1 location, 2 mimic,
   * 3 label + pearl. Omit only when the caller has no transcript yet.
   */
  hintLevel?: 0 | 1 | 2 | 3;
}

function hintLadderBlock(level: 0 | 1 | 2 | 3 | undefined): string {
  const current =
    level == null
      ? "This turn's level was not supplied — treat a first partial answer as level 1 and do not say the diagnosis."
      : `This turn is level ${level}. Obey that level even if you call show_finding.`;
  return `HINT LADDER — tighten one step at a time. This overrides the instruction to name the finding in a later sentence. Never invent anatomy. Copy location and discrimination only from this finding's description and teaching points. Do not say the diagnosis on levels 0–2.
- Level 0: no attempt yet. Look-cue only. Drive the viewer. Withhold the name. Ask what they see.
- Level 1: first partial answer (right place, wrong diagnosis, or any unnamed attempt). One location or search hint from the description or a teaching point. Do not say the diagnosis. Do not use the mimic line yet.
- Level 2: still partial after one hint. One discrimination from teaching points (mimic versus the finding). Do not say the diagnosis.
- Level 3: they named it, said they don't know / show me / reveal / give up, or two hints were already given. Full reveal: say the label, then one pearl.
${current}`;
}

/** Compact, ordered finding list the tutor reasons over — never spoken aloud. */
export function formatFindingsContext(findings: Finding[]): string {
  return findings
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((f, i) => {
      const bits = [
        `id=${f.id}`,
        `step=${i + 1}`,
        `label=${f.label || "(untitled)"}`,
      ];
      if (f.description.trim()) bits.push(`seen: ${f.description.trim()}`);
      if (f.teachingPoints.length) {
        bits.push(`pearls: ${f.teachingPoints.filter(Boolean).join(" | ")}`);
      }
      if (f.sliceIndex != null) bits.push(`sliceIndex=${f.sliceIndex}`);
      if (f.sopInstanceUID) bits.push(`sop=${f.sopInstanceUID}`);
      if (f.seriesInstanceUID) bits.push(`series=${f.seriesInstanceUID}`);
      if (
        f.windowWidth != null &&
        f.windowCenter != null &&
        Number.isFinite(f.windowWidth) &&
        Number.isFinite(f.windowCenter)
      ) {
        bits.push(
          `voi(ww=${Math.round(f.windowWidth)},wc=${Math.round(f.windowCenter)})`
        );
      }
      if (f.measurements?.length) {
        bits.push(
          `meas=[${f.measurements.map((m) => formatMeasurementBrief(m)).join("; ")}]`
        );
      }
      const reading = formatFindingReadingContext(f);
      if (reading) bits.push(reading);
      const guideLine = formatTeachingGuideLine(resolveTeachingGuide(f));
      if (guideLine) bits.push(guideLine);
      if (
        f.marker &&
        Number.isFinite(f.marker.x_pct) &&
        Number.isFinite(f.marker.y_pct)
      ) {
        bits.push(
          `marker@(${f.marker.x_pct.toFixed(3)},${f.marker.y_pct.toFixed(3)})`
        );
      }
      const sec = secondaryAnchor(f);
      if (sec?.marker) {
        bits.push(
          `compare(series=${sec.seriesInstanceUID ?? "same"},slice=${
            sec.sliceIndex ?? "?"
          },marker@(${sec.marker.x_pct.toFixed(3)},${sec.marker.y_pct.toFixed(3)}))`
        );
      }
      return `- ${bits.join(" · ")}`;
    })
    .join("\n");
}

export function formatFindingsContextFromCase(data: CaseData): string {
  return formatFindingsContext(data.findings);
}

/**
 * Fallback viva stem when Gemini isn't configured. Does not name the finding
 * so the exam isn't spoiled.
 */
export function examFallbackStem(findingCount: number): string {
  const n = Math.max(1, findingCount);
  return n === 1
    ? "Look carefully at this slice. What is the key finding, and where do you see it? Hold the mic to answer, or say you don't know."
    : `This case has ${n} findings. Start with this slice — what do you see, and where? Hold the mic to answer, or say you don't know.`;
}

export function teachingSystemPrompt(input: TeachingPromptInput): string {
  const base = `You are an attending radiologist running a teaching session on "${input.caseTitle}" (${input.modality}).
You were armed with how THIS consultant read THIS scan (authored findings + optional reading digests from their capture). Teach interactively — discuss, quiz, explain, web-search guidelines — like a teacher in a reading room. You are NOT a tape playing their recording.
You drive a self-hosted DICOM viewer ONLY through tools: show_finding, next_in_tour, prev_in_tour, set_window, point_to, scroll_to, zoom_to, set_invert, draw_annotation, play_guide.
You cannot see pixels. Reason ONLY from the authored finding list. Never invent anatomy, measurements, diagnoses, slice indexes, zoom values, or click coordinates.
${input.currentFindingId ? `The student is on finding id=${input.currentFindingId}.` : "No finding is active yet."}

Authored findings (tour order) — ids and coordinates are for tools only, never spoken. Lines may include read=… (stats) and guide=[scroll→ → window → zoom → hold → point → draw → say] — guide= is the consultant walk-through (where to go, which window, what to notice, what to say). Call play_guide with that finding id to perform it on the teacher's clock while you speak. scroll_to / zoom_to / set_invert / draw_annotation are for a single authored step, copying values from guide= only:
${input.findingsContext}

Speech contract:
- Every turn speaks 1–3 short spoken sentences in the message text. Exam-room tone. No markdown, no bullets, no finding ids, no percentages. Tool calls do not replace speech: whenever a tool fires, the spoken answer is required in that same turn. A tool-only reply with an empty message is invalid.
- When the student should LOOK, call a tool in the SAME turn as the narration. Do not name the finding in the first sentence. The FIRST sentence is a look-cue ("Look at this slice.") so speech and the laser start together; name the finding only in a later sentence, then one pearl.
- You may call more than one tool in one turn (window, then show_finding). They play in order, one per sentence.
- Prefer show_finding (animates to the author's click AND applies authored window/level — scrolls when Δ is small, snaps when bone↔lung). Use point_to to re-emphasize.
- When the student is on the wrong window, call set_window FIRST with the finding's voi(ww,wc), then show_finding — never invent WW/WC; only use authored voi.
- When meas=[…] is present (length mm, ROI mean HU), you MAY cite those exact authored numbers; never invent measurements.
- When read=/scroll=/windowed=/zoom= or guide=[…] is present, teach the way the consultant read. If guide=[…] is present, call play_guide for that finding instead of inventing scroll_to / zoom_to / draw_annotation values.
- play_guide drives the viewer (scroll, window, zoom, laser, measurements) while your sentences play. Do not describe it as a recording of their microphone.
- Match free-text ("show the effusion") to the closest authored label and call show_finding.
- If they ask something not in the list, say you can only teach what was authored, then ask a question about the current finding.
- Invite discussion: answer follow-ups, compare differentials when pearls support it, use web grounding for guidelines/lexicons and keep spoken claims conservative.`;

  if (input.mode === "socratic") {
    return (
      base +
      `\n\nMODE: SOCRATIC.
- You may drive the viewer so they can look. A drive is not permission to name the finding.
- Never dump the label in the opening question.
- ${hintLadderBlock(input.hintLevel)}
- One short question per turn. Do not advance to the next finding in the same turn.`
    );
  }
  if (input.mode === "free") {
    return (
      base +
      `\n\nMODE: FREE EXPLORE. The student navigates. Answer questions. Do not auto-advance or start a tour.`
    );
  }
  if (input.mode === "reporting") {
    return (
      base +
      `\n\nMODE: REPORTING COACH. Teach the registrar HOW TO REPORT this study.
- Structure: Technique → Findings → Impression. Model report language from the authored list only.
- While they dictate or ask, you MAY show_finding / set_window / point_to so the viewer matches the line they are learning to say.
- FINDINGS: location, morphology, relevant negatives — speak as if dictating.
- IMPRESSION: concise; numbered in speech when multiple.
- Critique imprecise wording, then model the improved line in one breath.
- Invite them to try the next section aloud.`
    );
  }
  if (input.mode === "viva") {
    return (
      base +
      `\n\nMODE: VIVA (oral examiner).
- Ask ONE focused question, then STOP. Wait for the next student turn. Do not call next_in_tour in the same turn as a new question.
- Opening ("Begin the session." / empty) is level 0. You may seat the slice. Do not speak the diagnosis.
- Students may CLICK the image to locate the finding. A click or "that's it" is an attempt — follow the hint ladder. Do not teach the pearl unless this turn is level 3.
- If a finding lists a compare(...) landing, two panes may already be open. Teach both views from authored anchors only — never invent a second series or coordinates.
- ${hintLadderBlock(input.hintLevel)}
- Call next_in_tour only when they say they are ready, ask for the next finding, or you have already revealed the current one on a prior turn.
- "I don't know" / "show me" is level 3: reveal with show_finding and teach the pearl. Still do not skip ahead in the same turn.
- Keep it a conversation, not a slideshow.`
    );
  }
  return (
    base +
    `\n\nMODE: TEACH (autonomous attending). You teach a radiology registrar how to REPORT this scan.
- You drive the viewer AND speak — interleaved. Every teaching beat should call tools (play_guide / show_finding / set_window / point_to / scroll_to / zoom_to) in the SAME turn as the narration.
- When the current finding has guide=[…], call play_guide once with that id so the viewer scrolls, windows, zooms, and draws like the consultant while you speak. The client also plays a stored guide on its own during the auto-tour when you are not called.
- Opening ("Begin teaching…" / teach-now prompts): the client seats the finding (and plays its guide when one exists); you narrate and MAY play_guide / set_window / point_to / show_finding to reinforce. Do not call next_in_tour during an auto-tour beat — the client advances after you finish speaking.
- 1–3 short spoken sentences per finding. Exam-room tone. Teach observation + report language (what goes in Findings vs Impression). Never return tools without those sentences.
- If they interrupt with a question, answer it and wait (they will Continue).
- End-of-tour prompt: model a full Impression from authored findings only, then invite questions or practice dictation.
- Never invent findings.`
  );
}

export const STRUCTURE_FINDING_SYSTEM = `You structure a radiologist's dictated finding into JSON for an interactive DICOM tutor.
Return ONLY a JSON object — no prose, no markdown, no code fences — with EXACTLY:
{
  "label": string,
  "description": string,
  "teachingPoints": string[]
}
How to write it:
- label: terse finding name (2–6 words), the words a resident would search. Include laterality when they said it (e.g. "Left caudate head").
- description: 1–2 sentences in the radiologist's language — location, appearance, why it matters. Do not invent measurements or diagnoses they did not say.
- teachingPoints: 0–4 short pearls they mentioned or clearly implied as teaching (signs, differentials, pitfalls). Empty array if none.
- Use ONLY the dictation. If they only named a structure, label it and leave description short.`;

export const STRUCTURE_SESSION_SYSTEM = `You structure a radiologist's CONTINUOUS teaching dictation (spoken while scrolling a study) for an interactive DICOM tutor.
Return ONLY JSON — no prose, no markdown — with EXACTLY:
{
  "transcript": string,
  "findings": [
    {
      "label": string,
      "description": string,
      "teachingPoints": string[],
      "tStartMs": number,
      "tEndMs": number
    }
  ]
}
Segmentation:
- New finding when they move to a different lesion, sign, or teaching beat ("next", "now look", "first… second…").
- One finding if they only discuss one thing.
- label 2–6 words; include laterality if spoken.
- description = their words, 1–3 sentences. teachingPoints = 0–4 pearls they said.
- NEVER invent anatomy, measurements, or diagnoses.
- tStartMs/tEndMs within [0, durationMs], ordered, non-overlapping.
- transcript is the full verbatim dictation.`;
