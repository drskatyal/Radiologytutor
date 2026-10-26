import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyLocateClick,
  examEntryTransition,
  locateModeArmed,
  mergeExamReveal,
  spoilFindingOnNavigate,
} from "./examLocate.ts";
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

test("moving between findings in exam does not uncover the marker", () => {
  assert.equal(spoilFindingOnNavigate("viva"), false);
  assert.equal(spoilFindingOnNavigate("socratic"), false);
  assert.equal(spoilFindingOnNavigate("guided"), true);
  assert.equal(spoilFindingOnNavigate("reporting"), true);
});
