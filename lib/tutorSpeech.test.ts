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
  examHintLevel,
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

const partial = "There is a line at the right apex. I think it is consolidation.";

test("socratic partial answer is a look-cue and withholds the diagnosis", () => {
  const answer = ensureSpokenAnswer({
    answer: "",
    mode: "socratic",
    question: partial,
    actions: [{ type: "show_finding", findingId: "f_ptx" }],
    findings,
    currentFindingId: "f_ptx",
  });
  const sentences = splitSentences(answer);
  assert.equal(
    examHintLevel({
      mode: "socratic",
      question: partial,
      finding: findings[0],
      findings,
      history: [],
    }),
    0
  );
  assert.match(sentences[0] ?? "", /^(Look|See|Watch|Follow)\b/);
  assert.match(answer, /What do you see\?/);
  assert.doesNotMatch(answer, /pneumothorax/i);
  assert.doesNotMatch(answer, /pleural line/i);
  assert.doesNotMatch(answer, /skin fold/i);
  assert.doesNotMatch(answer, /consolidation/i);
  assert.doesNotMatch(answer, /\bf_ptx\b/);
  assert.doesNotMatch(answer, /\b0\.\d{2,}\b/);
});

test("second vague answer is a location line and withholds the diagnosis", () => {
  const answer = ensureSpokenAnswer({
    answer: "",
    mode: "socratic",
    question: "The place is right, but I still call it consolidation.",
    history: [{ role: "user", text: partial, findingId: "f_ptx" }],
    actions: [{ type: "show_finding", findingId: "f_ptx" }],
    findings,
    currentFindingId: "f_ptx",
  });
  assert.equal(
    examHintLevel({
      mode: "socratic",
      question: "still not sure",
      finding: findings[0],
      findings,
      history: [{ role: "user", text: partial, findingId: "f_ptx" }],
      currentFindingId: "f_ptx",
    }),
    1
  );
  assert.match(splitSentences(answer)[0] ?? "", /^(Look|See|Watch|Follow)\b/);
  assert.match(answer, /pleural line|apex/i);
  assert.doesNotMatch(answer, /pneumothorax/i);
  assert.doesNotMatch(answer, /skin fold/i);
  assert.doesNotMatch(answer, /consolidation/i);
});

test("third vague answer is the mimic contrast and still withholds the label", () => {
  const answer = ensureSpokenAnswer({
    answer: "",
    mode: "viva",
    question: "I still think it is consolidation.",
    history: [
      { role: "user", text: partial, findingId: "f_ptx" },
      { role: "assistant", text: "Look at this slice. Visceral pleural line at the apex.", findingId: "f_ptx" },
      { role: "user", text: "The place is right, but I still call it consolidation.", findingId: "f_ptx" },
      { role: "assistant", text: "Look at this slice. Visceral pleural line at the apex.", findingId: "f_ptx" },
    ],
    actions: [{ type: "point_to", findingId: "f_ptx" }],
    findings,
    currentFindingId: "f_ptx",
  });
  assert.equal(
    examHintLevel({
      mode: "viva",
      question: "I still think it is consolidation.",
      finding: findings[0],
      findings,
      history: [
        { role: "user", text: partial, findingId: "f_ptx" },
        { role: "user", text: "The place is right, but I still call it consolidation.", findingId: "f_ptx" },
      ],
      currentFindingId: "f_ptx",
    }),
    2
  );
  assert.match(splitSentences(answer)[0] ?? "", /^(Look|See|Watch|Follow)\b/);
  assert.match(answer, /skin fold/i);
  assert.doesNotMatch(answer, /pneumothorax/i);
  assert.doesNotMatch(answer, /pleural line/i);
  assert.doesNotMatch(answer, /consolidation/i);
});

test("a later partial reveals once location and mimic were already given", () => {
  const history = [
    { role: "user" as const, text: partial, findingId: "f_ptx" },
    { role: "assistant" as const, text: "Look at this slice. Visceral pleural line at the apex.", findingId: "f_ptx" },
    { role: "user" as const, text: "Still consolidation.", findingId: "f_ptx" },
    { role: "assistant" as const, text: "Look at this slice. Do not call it a skin fold.", findingId: "f_ptx" },
    { role: "user" as const, text: "I still think it is consolidation.", findingId: "f_ptx" },
  ];
  const answer = ensureSpokenAnswer({
    answer: "",
    mode: "socratic",
    question: "No, still consolidation.",
    history,
    actions: [{ type: "show_finding", findingId: "f_ptx" }],
    findings,
    currentFindingId: "f_ptx",
  });
  assert.equal(
    examHintLevel({
      mode: "socratic",
      question: "No, still consolidation.",
      finding: findings[0],
      findings,
      history,
      currentFindingId: "f_ptx",
    }),
    3
  );
  assert.doesNotMatch(splitSentences(answer)[0] ?? "", /pneumothorax/i);
  assert.match(answer, /Right apical pneumothorax/);
  assert.match(answer, /skin fold/i);
});

test("show me and a correct name reveal immediately", () => {
  const shown = ensureSpokenAnswer({
    answer: "",
    mode: "socratic",
    question: "show me",
    actions: [{ type: "show_finding", findingId: "f_ptx" }],
    findings,
    currentFindingId: "f_ptx",
  });
  assert.match(shown, /Right apical pneumothorax/);
  assert.match(shown, /skin fold/i);

  const named = ensureSpokenAnswer({
    answer: "",
    mode: "viva",
    question: "It is a pneumothorax.",
    actions: [{ type: "show_finding", findingId: "f_ptx" }],
    findings,
    currentFindingId: "f_ptx",
  });
  assert.match(named, /Right apical pneumothorax/);
  assert.doesNotMatch(splitSentences(named)[0] ?? "", /pneumothorax/i);
});

const lidcSearch = {
  id: "f_lidc",
  label: "Lung window — start mid-chest",
  description:
    "Set a narrow lung window (approx. W 1500 / L -600). Begin at the carina and scroll inferiorly through both lungs.",
  teachingPoints: [
    "Name your search pattern before you scroll — upper lobes first or systematic lobe-by-lobe.",
    "Do not chase mediastinum until both lungs are surveyed.",
  ],
  order: 0,
};

test("a search-step title is not a correct name and does not reset the ladder", () => {
  assert.equal(
    examHintLevel({
      mode: "socratic",
      question: "Lung window — start mid-chest",
      finding: lidcSearch,
      findings: [lidcSearch],
      currentFindingId: "f_lidc",
      history: [{ role: "user", text: "is it a vessel?", findingId: "f_lidc" }],
    }),
    1
  );
  assert.equal(
    examHintLevel({
      mode: "socratic",
      question: "still not sure",
      finding: lidcSearch,
      findings: [lidcSearch],
      currentFindingId: "f_lidc",
      history: [
        { role: "user", text: "is it a vessel?", findingId: "f_lidc" },
        {
          role: "assistant",
          text: "Lung window — start mid-chest. Name your search pattern before you scroll.",
          findingId: "f_lidc",
        },
      ],
    }),
    1
  );
});

test("a search line that says window does not reset the same finding", () => {
  const history = [
    { role: "user" as const, text: "is it a vessel?", findingId: "f_lidc" },
    {
      role: "assistant" as const,
      text: "Follow the pointer. Set a narrow lung window. Begin at the carina.",
      findingId: "f_lidc",
    },
  ];
  assert.equal(
    examHintLevel({
      mode: "socratic",
      question: "still not sure",
      finding: lidcSearch,
      findings: [lidcSearch],
      history,
      currentFindingId: "f_lidc",
    }),
    1
  );
});

test("second vague turn replaces search copy with the region", () => {
  const answer = ensureSpokenAnswer({
    answer: "Follow the pointer. Begin at the carina and scroll inferiorly through both lungs.",
    mode: "socratic",
    question: "still not sure",
    history: [
      { role: "user", text: "is it a vessel?", findingId: "f_lidc" },
      {
        role: "assistant",
        text: "Follow the pointer. What do you see?",
        findingId: "f_lidc",
      },
    ],
    actions: [{ type: "point_to", findingId: "f_lidc" }],
    findings: [lidcSearch],
    currentFindingId: "f_lidc",
  });
  assert.match(splitSentences(answer)[0] ?? "", /^(Look|See|Watch|Follow)\b/);
  assert.match(answer, /both lungs/i);
  assert.doesNotMatch(answer, /\bcarina\b/i);
  assert.doesNotMatch(answer, /\bscroll\b/i);
  assert.doesNotMatch(answer, /\bsurvey\b/i);
  assert.doesNotMatch(answer, /\bwindow\b/i);
  assert.doesNotMatch(answer, /Lung window — start mid-chest/i);
  assert.doesNotMatch(answer, /nodule/i);
});

test("I don't know does not reveal a search-step title or a search-pattern prompt", () => {
  const answer = ensureSpokenAnswer({
    answer: "Look at this slice. Lung window — start mid-chest. Name your search pattern before you scroll — upper lobes first or systematic lobe-by-lobe.",
    mode: "socratic",
    question: "I don't know. Please show me this finding and teach it.",
    history: [
      { role: "user", text: "is it a vessel?", findingId: "f_lidc" },
      { role: "assistant", text: "Follow the pointer. What do you see?", findingId: "f_lidc" },
    ],
    actions: [{ type: "show_finding", findingId: "f_lidc" }],
    findings: [lidcSearch],
    currentFindingId: "f_lidc",
  });
  assert.match(splitSentences(answer)[0] ?? "", /^(Look|See|Watch|Follow)\b/);
  assert.match(answer, /Do not chase mediastinum until both lungs are surveyed/i);
  assert.doesNotMatch(answer, /Lung window — start mid-chest/i);
  assert.doesNotMatch(answer, /search pattern/i);
  assert.doesNotMatch(answer, /upper lobes first/i);
  assert.doesNotMatch(answer, /nodule|pneumothorax|consolidation/i);
});

const lidcNodule: SpokenFindingSource = {
  id: "f_nodule",
  label: "Peripheral nodule",
  description:
    "Round opacity in the periphery of the right upper lobe. Begin at the carina and scroll inferiorly through both lungs.",
  teachingPoints: [
    "Lung window — start mid-chest",
    "Name your search pattern before you scroll — upper lobes first or systematic lobe-by-lobe.",
    "If it vanishes on the next slice it is a vessel, not a nodule.",
  ],
  order: 1,
};

test("LIDC-like second vague is the description landmark, not the carina scroll", () => {
  const history = [
    { role: "user" as const, text: "is it a vessel?", findingId: "f_nodule" },
    {
      role: "assistant" as const,
      text: "Follow the pointer. What do you see?",
      findingId: "f_nodule",
    },
  ];
  assert.equal(
    examHintLevel({
      mode: "socratic",
      question: "still not sure",
      finding: lidcNodule,
      findings: [lidcSearch, lidcNodule],
      history,
      currentFindingId: "f_nodule",
    }),
    1
  );
  const empty = ensureSpokenAnswer({
    answer: "",
    mode: "socratic",
    question: "still not sure",
    history,
    actions: [{ type: "point_to", findingId: "f_lidc" }],
    findings: [lidcSearch, lidcNodule],
    currentFindingId: "f_nodule",
  });
  const offline = tutorSpeechPlan({
    answer: "",
    mode: "socratic",
    question: "still not sure",
    history,
    actions: [],
    findings: [lidcSearch, lidcNodule],
    currentFindingId: "f_nodule",
    tourActive: false,
  });
  for (const answer of [empty, offline.answer]) {
    assert.match(answer, /periphery|right upper lobe/i);
    assert.doesNotMatch(answer, /\bcarina\b/i);
    assert.doesNotMatch(answer, /\bscroll\b/i);
    assert.doesNotMatch(answer, /\bsurvey\b/i);
    assert.doesNotMatch(answer, /\bwindow\b/i);
    assert.doesNotMatch(answer, /Lung window — start mid-chest/i);
    assert.doesNotMatch(answer, /\bnodule\b/i);
  }
});

test("I don't know speaks the diagnosis label and pearl, not the search-step title", () => {
  const asked = "I don't know. Please show me this finding and teach it.";
  const history = [
    { role: "user" as const, text: "is it a vessel?", findingId: "f_nodule" },
    { role: "assistant" as const, text: "Follow the pointer. What do you see?", findingId: "f_nodule" },
    { role: "user" as const, text: "still not sure", findingId: "f_nodule" },
  ];
  const answer = ensureSpokenAnswer({
    answer:
      "Look at this slice. Lung window — start mid-chest. Name your search pattern before you scroll — upper lobes first or systematic lobe-by-lobe.",
    mode: "socratic",
    question: asked,
    history,
    actions: [],
    findings: [lidcSearch, lidcNodule],
    currentFindingId: "f_nodule",
  });
  assert.match(answer, /Peripheral nodule/);
  assert.match(answer, /vessel, not a nodule/i);
  assert.doesNotMatch(answer, /Lung window — start mid-chest/i);
  assert.doesNotMatch(answer, /search pattern/i);
  assert.doesNotMatch(answer, /upper lobes first/i);
  assert.doesNotMatch(answer, /\bcarina\b/i);
  assert.doesNotMatch(answer, /\bscroll\b/i);
});

test("attempts on another finding do not climb this one", () => {
  assert.equal(
    examHintLevel({
      mode: "socratic",
      question: "still not sure",
      finding: findings[1],
      findings,
      currentFindingId: "f_nod",
      history: [
        { role: "user", text: partial, findingId: "f_ptx" },
        { role: "user", text: "Still consolidation.", findingId: "f_ptx" },
        { role: "assistant", text: "Right apical pneumothorax.", findingId: "f_ptx" },
      ],
    }),
    0
  );
});

test("offline fallback climbs the same ladder as an empty model", () => {
  const first = tutorSpeechPlan({
    answer: "",
    mode: "socratic",
    question: partial,
    actions: [],
    findings,
    currentFindingId: "f_ptx",
    tourActive: false,
    history: [],
  });
  assert.equal(first.speak, true);
  assert.match(first.answer, /^(Look|See|Watch|Follow)\b/);
  assert.match(first.answer, /What do you see\?/);
  assert.doesNotMatch(first.answer, /pneumothorax|pleural|skin fold/i);

  const second = tutorSpeechPlan({
    answer: "",
    mode: "socratic",
    question: "still not sure",
    actions: [],
    findings,
    currentFindingId: "f_ptx",
    tourActive: false,
    history: [{ role: "user", text: partial, findingId: "f_ptx" }],
  });
  assert.match(second.answer, /pleural line|apex/i);
  assert.doesNotMatch(second.answer, /\bpneumothorax\b/i);
  assert.doesNotMatch(second.answer, /skin fold/i);

  const third = tutorSpeechPlan({
    answer: "",
    mode: "socratic",
    question: "still not sure",
    actions: [],
    findings,
    currentFindingId: "f_ptx",
    tourActive: false,
    history: [
      { role: "user", text: partial, findingId: "f_ptx" },
      { role: "user", text: "The apex, but not sure.", findingId: "f_ptx" },
    ],
  });
  assert.match(third.answer, /skin fold/i);
  assert.doesNotMatch(third.answer, /\bpneumothorax\b/i);

  const reveal = tutorSpeechPlan({
    answer: "Look at this slice.",
    mode: "socratic",
    question: "show me",
    actions: [],
    findings,
    currentFindingId: "f_ptx",
    tourActive: false,
  });
  assert.match(reveal.answer, /Right apical pneumothorax/);
  assert.match(reveal.answer, /skin fold/i);
});

test("location hint redacts the diagnosis and does not invent a mimic", () => {
  const nod = {
    id: "f_nod",
    label: "Left lower lobe nodule",
    description: "8 mm solid nodule in the left lower lobe.",
    teachingPoints: ["If it vanishes on the next slice it is a vessel, not a nodule."],
    order: 1,
  };
  const answer = ensureSpokenAnswer({
    answer: "",
    mode: "socratic",
    question: "Round opacity in the left lower lobe. I call it a vessel.",
    history: [{ role: "user", text: "Something round. Maybe a vessel.", findingId: "f_nod" }],
    actions: [],
    findings: [nod],
    currentFindingId: "f_nod",
  });
  assert.match(answer, /left lower lobe/i);
  assert.doesNotMatch(answer, /\bnodule\b/i);
  assert.doesNotMatch(answer, /vessel/i);
  assert.doesNotMatch(answer, /carina|pleura|pneumothorax|consolidation/i);
});

test("a reveal resets the ladder for the next partial answer", () => {
  const answer = ensureSpokenAnswer({
    answer: "",
    mode: "socratic",
    question: "Now this one looks like a scar.",
    history: [
      { role: "user", text: partial },
      { role: "user", text: "Still consolidation." },
      { role: "assistant", text: "Look at this slice. Right apical pneumothorax." },
    ],
    actions: [{ type: "show_finding", findingId: "f_nod" }],
    findings,
    currentFindingId: "f_nod",
  });
  assert.match(splitSentences(answer)[0] ?? "", /^(Look|See|Watch|Follow)\b/);
  assert.match(answer, /What do you see\?/);
  assert.doesNotMatch(answer, /nodule/i);
  assert.doesNotMatch(answer, /left lower lobe/i);
  assert.doesNotMatch(answer, /pneumothorax/i);
  assert.doesNotMatch(answer, /scar/i);
});

test("empty authored hint text invents no anatomy", () => {
  const answer = ensureSpokenAnswer({
    answer: "",
    mode: "viva",
    question: "Something is wrong at the top.",
    actions: [{ type: "show_finding", findingId: "f_empty" }],
    findings: [
      {
        id: "f_empty",
        label: "Right apical pneumothorax",
        description: "",
        teachingPoints: [],
        order: 0,
      },
    ],
    currentFindingId: "f_empty",
  });
  assert.match(splitSentences(answer)[0] ?? "", /^(Look|See|Watch|Follow)\b/);
  assert.doesNotMatch(answer, /pneumothorax|pleura|apex|carina|skin fold|nodule/i);
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
    hintLevel: 1,
  });
  assert.match(viva, /empty message is invalid/i);
  assert.match(viva, /do not speak the diagnosis/i);
  assert.match(viva, /region or landmark/i);
  assert.match(viva, /not the label/i);
  assert.match(viva, /search-step title/i);

  assert.ok(HARNESS_VIEWER_TOOLS.length >= 10);
  for (const tool of HARNESS_VIEWER_TOOLS) {
    assert.match(tool.description, /spoken answer of 1–3 sentences/);
    assert.match(tool.description, /empty message/i);
  }
});
