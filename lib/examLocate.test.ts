import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendGuideTurn,
  applyLocateClick,
  beginFindingStep,
  commitGuideLine,
  commitSpokenProgress,
  commitSelectedFinding,
  examEntryTransition,
  examinerCaptionTurn,
  examinerVisibleTurns,
  findingStepLabel,
  locateModeArmed,
  mergeExamReveal,
  seatExamTranscript,
  settleFindingReveal,
  spoilFindingOnNavigate,
} from "./examLocate.ts";
import { examFallbackStem } from "./teachingPrompt.ts";
import type { Marker } from "./types.ts";

/** case-lidc-nodule-search finding 2, "Peripheral nodule survey". */
const nodule: Marker = { x_pct: 0.68, y_pct: 0.55, shape: "circle" };
const findingId = "f_caselidcno_2";

test("Teach → Exam drops teach reveals so an unlocated marker can be clicked", () => {
  const entered = examEntryTransition({
    fromMode: "guided",
    toMode: "viva",
    phase: "speaking",
    revealedIds: ["f_caselidcno_1", findingId],
    locatedIds: [],
  });
  assert.ok(entered);
  assert.equal(entered.interruptSpeech, true);
  assert.equal(entered.abortTutor, true);
  assert.equal(entered.phase, "idle");
  assert.equal(entered.dropPriorCaption, true);
  assert.deepEqual(entered.revealedIds, []);
  assert.equal(
    locateModeArmed({
      examMode: true,
      finding: { id: findingId, marker: nodule },
      revealedIds: entered.revealedIds,
      locatedIds: [],
    }),
    true
  );
});

test("a finding already located stays revealed and does not arm again", () => {
  const entered = examEntryTransition({
    fromMode: "guided",
    toMode: "socratic",
    phase: "idle",
    revealedIds: [findingId, "f_other"],
    locatedIds: [findingId],
  });
  assert.ok(entered);
  assert.deepEqual(entered.revealedIds, [findingId]);
  assert.equal(entered.phase, "idle");
  assert.equal(
    locateModeArmed({
      examMode: true,
      finding: { id: findingId, marker: nodule },
      revealedIds: entered.revealedIds,
      locatedIds: [findingId],
    }),
    false
  );
});

test("locate stays down when the finding was revealed inside the exam", () => {
  assert.equal(
    locateModeArmed({
      examMode: true,
      finding: { id: findingId, marker: nodule },
      revealedIds: [findingId],
      locatedIds: [],
    }),
    false
  );
});

test("locate stays down outside exam and when the finding has no marker", () => {
  assert.equal(
    locateModeArmed({
      examMode: false,
      finding: { id: findingId, marker: nodule },
      revealedIds: [],
      locatedIds: [],
    }),
    false
  );
  assert.equal(
    locateModeArmed({
      examMode: true,
      finding: { id: findingId, marker: null },
      revealedIds: [],
      locatedIds: [],
    }),
    false
  );
  assert.equal(
    locateModeArmed({
      examMode: true,
      finding: null,
      revealedIds: [],
      locatedIds: [],
    }),
    false
  );
});

test("staying in exam does not reset reveals or cut speech", () => {
  assert.equal(
    examEntryTransition({
      fromMode: "viva",
      toMode: "socratic",
      phase: "speaking",
      revealedIds: [findingId],
      locatedIds: [],
    }),
    null
  );
  assert.equal(
    examEntryTransition({
      fromMode: "guided",
      toMode: "reporting",
      phase: "speaking",
      revealedIds: [findingId],
      locatedIds: [],
    }),
    null
  );
});

test("a miss on the nodule survey hints and a hit locates", () => {
  const armed = {
    armed: true,
    busy: false,
    marker: nodule,
    priorMisses: 0,
  };
  const miss = applyLocateClick({ ...armed, x: 0.1, y: 0.1 });
  assert.equal(miss.type, "miss");
  if (miss.type !== "miss") return;
  assert.equal(miss.misses, 1);
  assert.equal(miss.hint, "Not quite — click the lesion, or hold the mic to describe it.");

  const again = applyLocateClick({ ...armed, x: 0.1, y: 0.1, priorMisses: miss.misses });
  assert.equal(again.type, "miss");
  if (again.type !== "miss") return;
  assert.equal(again.misses, 2);
  assert.equal(
    again.hint,
    "Still not it — say you don't know, or try one more click."
  );

  const hit = applyLocateClick({ ...armed, x: 0.68, y: 0.55, priorMisses: again.misses });
  assert.deepEqual(hit, { type: "hit" });
});

test("clicks are ignored when locate is not armed or the session is busy", () => {
  assert.deepEqual(
    applyLocateClick({
      armed: false,
      busy: false,
      marker: nodule,
      x: 0.68,
      y: 0.55,
      priorMisses: 0,
    }),
    { type: "ignore" }
  );
  assert.deepEqual(
    applyLocateClick({
      armed: true,
      busy: true,
      marker: nodule,
      x: 0.68,
      y: 0.55,
      priorMisses: 0,
    }),
    { type: "ignore" }
  );
});

test("a teach reveal queued before Exam entry cannot re-spoil the finding", () => {
  const stripped: string[] = [];
  assert.deepEqual(mergeExamReveal(stripped, findingId, 1, 2), []);
  assert.deepEqual(mergeExamReveal(stripped, findingId, 2, 2), [findingId]);
});

const tourLine = "Follow the stack. Follow the vessels as you move.";

test("Teach → Exam drops the tour caption from the examiner panel and seats the stem", () => {
  const prior = [
    { id: "tour", role: "assistant" as const, text: tourLine },
    { id: "ask", role: "user" as const, text: "why that window?" },
  ];
  // Raising the floor hides the footer caption. The panel still listed every turn.
  assert.equal(examinerCaptionTurn(prior, prior.length), null);
  assert.deepEqual(examinerVisibleTurns(prior, prior.length), []);

  const stem = examFallbackStem(3);
  const seated = seatExamTranscript(prior, {
    id: "stem",
    role: "assistant",
    text: stem,
    findingId,
  });
  const panel = examinerVisibleTurns(seated.turns, seated.captionFloor);
  const caption = examinerCaptionTurn(panel, 0);
  assert.equal(seated.captionFloor, 0);
  assert.equal(caption?.text, stem);
  assert.deepEqual(
    panel.map((turn) => turn.text),
    [stem]
  );
  assert.doesNotMatch(panel.map((turn) => turn.text).join(" "), /Follow the stack|Follow the vessels/);
  assert.match(stem, /what do you see/i);
  assert.equal(caption?.findingId, findingId);

  const entered = examEntryTransition({
    fromMode: "guided",
    toMode: "viva",
    phase: "speaking",
    revealedIds: [findingId],
    locatedIds: [],
  });
  assert.ok(entered);
  assert.equal(
    locateModeArmed({
      examMode: true,
      finding: { id: findingId, marker: nodule },
      revealedIds: entered.revealedIds,
      locatedIds: [],
    }),
    true
  );
});

test("a blank exam stem leaves the examiner transcript empty", () => {
  const seated = seatExamTranscript(
    [{ id: "tour", role: "assistant", text: tourLine }],
    { id: "stem", role: "assistant", text: "   " }
  );
  assert.equal(seated.captionFloor, 0);
  assert.deepEqual(seated.turns, []);
  assert.equal(examinerCaptionTurn(seated.turns, seated.captionFloor), null);
});

test("a guide line scheduled before Exam cannot rewrite the seated stem", () => {
  const stem = examFallbackStem(3);
  const seated = seatExamTranscript(
    [{ id: "tour", role: "assistant", text: "Follow the stack." }],
    { id: "stem", role: "assistant", text: stem }
  );
  const appended = commitGuideLine(
    seated.turns,
    "stem",
    "Follow the vessels as you move.",
    1,
    2
  );
  const replaced = commitGuideLine(appended, "stem", tourLine, 1, 2, "replace");
  const added = appendGuideTurn(
    replaced,
    { id: "late", role: "assistant" as const, text: tourLine },
    1,
    2
  );
  assert.deepEqual(
    added.map((turn) => turn.text),
    [stem]
  );
});

test("guide lines still accumulate while Teach owns the epoch", () => {
  const started = appendGuideTurn([], { id: "tour", role: "assistant" as const, text: "" }, 1, 1);
  const orient = commitGuideLine(started, "tour", "Follow the stack.", 1, 1, "replace");
  const next = commitGuideLine(orient, "tour", "Follow the vessels as you move.", 1, 1);
  assert.equal(next[0]?.text, tourLine);
});

test("spoken progress captions the sentence in flight and keeps the transcript", () => {
  const started = appendGuideTurn([], { id: "tour", role: "assistant" as const, text: "" }, 1, 1);
  const first = commitSpokenProgress(started, "tour", "Follow the stack.", 1, 1);
  const second = commitSpokenProgress(first, "tour", "Name the nodule.", 1, 1);
  assert.equal(second[0]?.text, "Follow the stack. Name the nodule.");
  assert.equal(second[0]?.liveCaption, "Name the nodule.");
  const caption = examinerCaptionTurn(second, 0);
  assert.equal(caption?.text, "Name the nodule.");
  // Rail still has both sentences. Only the on-image line is the live one.
  assert.equal(second[0]?.text.includes("Follow the stack."), true);

  const late = commitSpokenProgress(second, "tour", "A stale pearl.", 1, 2);
  assert.equal(late[0]?.liveCaption, "Name the nodule.");
  assert.equal(late[0]?.text.includes("stale"), false);
});

test("moving between findings in exam does not uncover the marker", () => {
  assert.equal(spoilFindingOnNavigate("viva"), false);
  assert.equal(spoilFindingOnNavigate("socratic"), false);
  assert.equal(spoilFindingOnNavigate("guided"), true);
  assert.equal(spoilFindingOnNavigate("reporting"), true);
});

test("selecting finding 2 shows Finding 2 / 3 before the viewer tween settles", () => {
  // case-lidc-nodule-search: index 1 is "Peripheral nodule survey".
  // The header, rail, and progress dots read this step. They must not wait
  // for showState, in Exam or in Teach.
  const seated = commitSelectedFinding(beginFindingStep(), 0, 3);
  assert.ok(seated);
  assert.equal(findingStepLabel(seated.activeIndex, 3), "1 / 3");

  const picked = commitSelectedFinding(seated, 1, 3);
  assert.ok(picked);
  assert.equal(picked.activeIndex, 1);
  assert.equal(findingStepLabel(picked.activeIndex, 3), "2 / 3");

  // Finding 1's showState resolves after the click. It must not rewind the badge.
  const late = settleFindingReveal(picked, {
    index: 0,
    count: 3,
    selection: seated.selection,
  });
  assert.equal(late.activeIndex, 1);
  assert.equal(findingStepLabel(late.activeIndex, 3), "2 / 3");
  assert.equal(late.selection, picked.selection);
});

test("a reveal that is still the current selection keeps the step it committed", () => {
  const picked = commitSelectedFinding(beginFindingStep(), 1, 3);
  assert.ok(picked);
  const settled = settleFindingReveal(picked, {
    index: 1,
    count: 3,
    selection: picked.selection,
  });
  assert.equal(settled.activeIndex, 1);
  assert.equal(findingStepLabel(settled.activeIndex, 3), "2 / 3");
});

test("an out-of-range finding selection leaves the step chrome alone", () => {
  const seated = commitSelectedFinding(beginFindingStep(), 0, 3);
  assert.ok(seated);
  assert.equal(commitSelectedFinding(seated, -1, 3), null);
  assert.equal(commitSelectedFinding(seated, 3, 3), null);
  assert.equal(commitSelectedFinding(seated, 1, 0), null);
  assert.equal(findingStepLabel(-1, 3), null);
  assert.equal(findingStepLabel(1, 0), null);
});
