/**
 * Tutor-eval fixture for the LIDC demo guide.
 *
 * Built from the catalog plus buildLidcDemoGuide, scaled to the public
 * 65-slice series (findings land on 34 / 49 / 64). No pixels and no PHI.
 * The reference tutor speaks the guide's say lines while it drives.
 */

import { LIDC_CASE_ID, LIDC_STACK_SLICES, planPublicCaseFindings } from "./demoTeachingGuide";
import { getPublicCaseTemplate } from "./publicCases/catalog";
import type { TutorEvalBeat, TutorEvalFixture } from "./harness/tutorEval";
import type { Finding } from "./types";

const COPY: Record<
  number,
  { id: string; terms: string[]; prompt: string; chatbot: string }
> = {
  1: {
    id: "beat-orient",
    terms: ["carina"],
    prompt:
      "Teach the opening pass. I am on soft-tissue windows at the top of the stack. Drive the viewer, then teach.",
    chatbot:
      "Follow this slice. Begin at the carina and survey both lungs before the mediastinum.",
  },
  2: {
    id: "beat-nodule",
    terms: ["nodule"],
    prompt: "Teach the nodule search. Drive the viewer, then name what you committed to.",
    chatbot:
      "Look at the periphery. A nodule has to persist on adjacent slices, unlike a vessel on end.",
  },
  3: {
    id: "beat-mediastinum",
    terms: ["hila"],
    prompt: "Teach the mediastinal pass. Drive the viewer, then give the pearl.",
    chatbot:
      "Look at the hila on mediastinal windows, then separate actionable findings from calcified granulomas.",
  },
};

function spoken(finding: Finding): string {
  return (finding.teachingGuide?.beats ?? [])
    .map((beat) => beat.say?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}

export function buildLidcTutorFixture(): TutorEvalFixture {
  const template = getPublicCaseTemplate(LIDC_CASE_ID);
  if (!template) throw new Error(`Missing public case template ${LIDC_CASE_ID}.`);
  const planned = planPublicCaseFindings(LIDC_CASE_ID, template.findings, LIDC_STACK_SLICES);
  const findings: Finding[] = planned.create.map((finding) => ({
    ...(finding as Omit<Finding, "id">),
    id: `f_lidc_${finding.order ?? 1}`,
  }));
  const beats: TutorEvalBeat[] = findings.map((finding) => {
    const copy = COPY[finding.order];
    if (!copy) throw new Error(`No eval copy for LIDC finding order ${finding.order}.`);
    return {
      id: copy.id,
      findingId: finding.id,
      prompt: copy.prompt,
      distinctiveTerms: copy.terms,
      drivingNarration: spoken(finding),
      chatbotNarration: copy.chatbot,
    };
  });
  const series = template.source.seriesInstanceUID;
  return {
    id: "lidc-nodule-search",
    phi: "none",
    notes:
      "LIDC demo teaching guide. Public 65-slice chest CT anchors scaled to slices 34, 49, and 64. No pixels, no PHI. The reference speaks the guide (orient, search, lean-in, commit, pearl) instead of a single paragraph.",
    mode: "guided",
    initialViewer: {
      sliceIndex: 0,
      windowWidth: 400,
      windowCenter: 40,
      zoom: 1,
      seriesInstanceUID: series,
    },
    case: {
      caseId: LIDC_CASE_ID,
      title: template.title,
      modality: template.modality,
      pacsbinBaseUrl: "https://eval.flowrad.local/viewer/lidc-nodule-search",
      orgId: "org_eval",
      status: "published",
      specialty: template.specialty,
      difficulty: template.difficulty,
      system: template.system,
      tags: ["eval", "LIDC", "nodule"],
      clinicalHistory: template.clinicalHistory,
      technique: template.technique,
      primaryDiagnosis: template.primaryDiagnosis,
      differentials: template.differentials,
      targetLevel: template.targetLevel,
      learningObjectives: template.learningObjectives,
      discussion:
        "Eval fixture for the LIDC demo teaching guide. The pearl is the authored finding text. No pixels are loaded.",
      references: [],
      findings,
    },
    beats,
  };
}
