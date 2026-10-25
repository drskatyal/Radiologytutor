import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPerformancePlan, splitSentences } from "./performancePlan.ts";
import { HARNESS_VIEWER_TOOLS } from "./harness/tools.ts";
import {
  humanTeachActions,
  loadTutorFixture,
  resolveTeachingGuide,
  scoreTutorSession,
} from "./harness/tutorEval.ts";
import { teachingSystemPrompt } from "./teachingPrompt.ts";
import {
  ensureSpokenAnswer,
  mayNameFinding,
  NARRATION_HOLD_MAX_MS,
  NARRATION_HOLD_MIN_MS,
  TTS_START_BUDGET_MS,
  narrationHoldMs,
  speechAudioCanBlock,
  tutorSpeechPlan,
  type SpokenFindingSource,
} from "./tutorSpeech.ts";

const findings: SpokenFindingSource[] = [
  {
    id: "f_ptx",
    label: "Right apical pneumothorax",
    description: "Visceral pleural line at the apex. marker at 0.280.",
    teachingPoints: ["Do not call it a skin fold."],
    order: 0,
  },
  {
    id: "f_nod",
    label: "Left lower lobe nodule",
    description: "8 mm solid nodule in the left lower lobe.",
    teachingPoints: ["Keep it out of the pneumothorax impression."],
    order: 1,
  },
];

const drives = [
  { type: "scroll_to", findingId: "f_ptx" },
  { type: "set_window", findingId: "f_ptx" },
  { type: "point_to", findingId: "f_ptx" },
];

function teach(question = "Teach the finding now on screen.") {
  return ensureSpokenAnswer({
    answer: "",
    mode: "guided",
    question,
    actions: drives,
    findings,
    currentFindingId: "f_ptx",
  });
}

test("empty tool plan speaks a look-cue before the authored name", () => {
  const answer = teach();
  const sentences = splitSentences(answer);
  assert.ok(sentences.length > drives.length);
  assert.match(sentences[0] ?? "", /^(Look|See|Watch|Follow)\b/);
  for (let i = 0; i < drives.length; i++) {
    assert.doesNotMatch(sentences[i] ?? "", /pneumothorax|pleural|nodule|skin fold/i);
    assert.doesNotMatch(sentences[i] ?? "", /f_ptx|0\.280/);
  }
  const after = sentences.slice(drives.length).join(" ");
  assert.match(after, /Right apical pneumothorax/);
  assert.match(after, /Visceral pleural line at the apex/);
  assert.match(after, /Do not call it a skin fold/);
  assert.doesNotMatch(answer, /\bf_ptx\b/);
  assert.doesNotMatch(answer, /\b0\.\d{2,}\b/);
  assert.doesNotMatch(answer, /consolidation|effusion|fracture/i);

  const plan = buildPerformancePlan(answer, drives);
  assert.ok(plan[0]?.actions.length);
  const nameAt = plan.findIndex((beat) => /pneumothorax/i.test(beat.text));
  const lastDrive = plan.reduce((acc, beat, index) => (beat.actions.length ? index : acc), -1);
  assert.ok(nameAt > lastDrive, "label sentence must follow every drive sentence");
});

test("a real answer is left unchanged", () => {
  const given = "Look at this slice. The pleural line is the finding.";
  const answer = ensureSpokenAnswer({
    answer: `  ${given}  `,
    mode: "guided",
    question: "Teach the finding now on screen.",
    actions: drives,
    findings,
    currentFindingId: "f_ptx",
  });
  assert.equal(answer, given);
});

test("whitespace-only answer is treated as empty", () => {
  const answer = ensureSpokenAnswer({
    answer: " \n\t ",
    mode: "guided",
    question: "Teach the finding now on screen.",
    actions: [{ type: "show_finding", findingId: "f_ptx" }],
    findings,
    currentFindingId: "f_ptx",
  });
  assert.match(answer, /Right apical pneumothorax/);
  assert.doesNotMatch(splitSentences(answer)[0] ?? "", /pneumothorax/i);
});

test("next_in_tour names the following finding only", () => {
  const answer = ensureSpokenAnswer({
    answer: "",
    mode: "guided",
    question: "Next.",
    actions: [{ type: "next_in_tour" }],
    findings,
    currentFindingId: "f_ptx",
  });
  assert.match(answer, /Left lower lobe nodule/);
  assert.match(answer, /8 mm solid nodule/);
  assert.match(answer, /Keep it out of the pneumothorax impression/);
  assert.doesNotMatch(answer, /Right apical|pleural line|skin fold/i);
});

test("viva opening drives without naming the finding", () => {
  const answer = ensureSpokenAnswer({
    answer: "",
    mode: "viva",
    question: "Begin the session.",
    actions: [{ type: "show_finding", findingId: "f_ptx" }],
    findings,
    currentFindingId: "f_ptx",
  });
  assert.match(splitSentences(answer)[0] ?? "", /^(Look|See|Watch|Follow)\b/);
  assert.match(answer, /What do you see\?/);
  assert.doesNotMatch(answer, /pneumothorax|pleural|skin fold/i);
  assert.equal(mayNameFinding("viva", "Begin the session.", drives), false);
});

test("viva reveal after an attempt names the finding after the cue", () => {
  const answer = ensureSpokenAnswer({
    answer: "",
    mode: "viva",
    question: "I don't know",
    actions: [{ type: "show_finding", findingId: "f_ptx" }],
    findings,
    currentFindingId: "f_ptx",
  });
  assert.doesNotMatch(splitSentences(answer)[0] ?? "", /pneumothorax/i);
  assert.match(answer, /Right apical pneumothorax/);
  assert.match(answer, /Do not call it a skin fold/);
});

test("missing authored text still yields a look-cue and invents nothing", () => {
  const answer = ensureSpokenAnswer({
    answer: "",
    mode: "guided",
    question: "Teach the finding now on screen.",
    actions: [{ type: "show_finding", findingId: "missing" }],
    findings: [],
    currentFindingId: "missing",
  });
  assert.match(answer, /^(Look|See|Watch|Follow)\b/);
  assert.doesNotMatch(answer, /pneumothorax|nodule|mass|consolidation/i);
});

test("impression fallback uses authored labels only", () => {
  const answer = ensureSpokenAnswer({
    answer: "",
    mode: "guided",
    question:
      "Tour complete. Model a concise Impression for this case from the authored findings only.",
    actions: [],
    findings,
  });
  assert.match(answer, /Right apical pneumothorax/);
  assert.match(answer, /Left lower lobe nodule/);
  assert.doesNotMatch(answer, /pleural line|skin fold|8 mm/i);
  assert.doesNotMatch(answer, /consolidation/i);
});

test("guided tour with no audio advances instead of waiting", () => {
  const silent = tutorSpeechPlan({
    answer: "",
    mode: "guided",
    question: "Teach the finding now on screen.",
    actions: [],
    findings: [],
    tourActive: true,
  });
  assert.equal(silent.speak, false);
  assert.equal(silent.advanceWithoutSpeech, true);

  const voiced = tutorSpeechPlan({
    answer: "",
    mode: "guided",
    question: "Teach the finding now on screen.",
    actions: [{ type: "show_finding", findingId: "f_ptx" }],
    findings,
    currentFindingId: "f_ptx",
    tourActive: true,
  });
  assert.equal(voiced.speak, true);
  assert.equal(voiced.advanceWithoutSpeech, false);
  assert.match(voiced.answer, /pneumothorax/i);
});

test("seated teach beat without tools still speaks the authored line", () => {
  const plan = tutorSpeechPlan({
    answer: "",
    mode: "guided",
    question: "Teach the finding now on screen.",
    actions: [],
    findings,
    currentFindingId: "f_ptx",
    tourActive: true,
    viewerAlreadySeated: true,
  });
  assert.equal(plan.speak, true);
  assert.equal(plan.advanceWithoutSpeech, false);
  assert.doesNotMatch(splitSentences(plan.answer)[0] ?? "", /pneumothorax/i);
  assert.match(plan.answer, /Right apical pneumothorax/);
});

test("empty audio cannot block the tour", () => {
  assert.equal(speechAudioCanBlock(0, 1.2), false);
  assert.equal(speechAudioCanBlock(128, 0), false);
  assert.equal(speechAudioCanBlock(128, 2.4), true);
  assert.equal(speechAudioCanBlock(128, null), true);
});

test("narration hold is zero for silence and capped for a long pearl", () => {
  assert.equal(narrationHoldMs(""), 0);
  assert.equal(narrationHoldMs("  \n"), 0);
  assert.equal(narrationHoldMs("Hi"), NARRATION_HOLD_MIN_MS);
  assert.equal(narrationHoldMs("a".repeat(70)), 6_500);
  assert.equal(narrationHoldMs("a".repeat(400)), NARRATION_HOLD_MAX_MS);
  assert.ok(NARRATION_HOLD_MAX_MS <= 12_000);
  assert.ok(TTS_START_BUDGET_MS >= 1_000);
  assert.ok(TTS_START_BUDGET_MS <= 3_000);
  assert.ok(TTS_START_BUDGET_MS < NARRATION_HOLD_MAX_MS);
});

test("empty-answer fallback keeps the consultant drive inside the eval speech bar", async () => {
  const fixture = loadTutorFixture();
  const score = await scoreTutorSession(
    fixture,
    (ctx) => {
      const guide = resolveTeachingGuide(ctx.beat, ctx.finding);
      const actions = humanTeachActions(ctx.finding, guide);
      const answer = ensureSpokenAnswer({
        answer: "",
        mode: "guided",
        question: ctx.beat.prompt,
        actions,
        findings: ctx.fixture.case.findings.map((finding) => ({
          id: finding.id,
          label: finding.label,
          description: finding.description,
          teachingPoints: finding.teachingPoints,
          order: finding.order,
        })),
        currentFindingId: ctx.finding.id,
      });
      return { answer, actions };
    },
    "empty-answer fallback"
  );
  assert.equal(score.hardPass, true, JSON.stringify(score.beats.map((beat) => ({
    id: beat.beatId,
    failed: beat.checks.filter((check) => !check.pass).map((check) => `${check.id}: ${check.detail}`),
  }))));
});

test("prompt and tool schema require a spoken answer whenever tools fire", () => {
  const prompt = teachingSystemPrompt({
    caseTitle: "LIDC nodule search",
    modality: "CT",
    mode: "guided",
    findingsContext: "id=f_ptx",
    currentFindingId: "f_ptx",
  });
  assert.match(prompt, /1–3 short spoken sentences/);
  assert.match(prompt, /empty message is invalid/i);
  assert.match(prompt, /Do not name the finding in the first sentence/);
  assert.match(prompt, /Never invent anatomy/);

  const viva = teachingSystemPrompt({
    caseTitle: "LIDC nodule search",
    modality: "CT",
    mode: "viva",
    findingsContext: "id=f_ptx",
  });
  assert.match(viva, /empty message is invalid/i);
  assert.match(viva, /do not speak the diagnosis/i);

  assert.ok(HARNESS_VIEWER_TOOLS.length >= 10);
  for (const tool of HARNESS_VIEWER_TOOLS) {
    assert.match(tool.description, /spoken answer of 1–3 sentences/);
    assert.match(tool.description, /empty message/i);
  }
});
