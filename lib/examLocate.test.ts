import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideLocateClick,
  examEntryPlan,
  examSpoilOnSeat,
  findingNavigationLocked,
  locateModeArmed,
  phaseAfterInterrupt,
  withholdUnrevealedExamActions,
} from "./examLocate.ts";
import type { Finding, Marker } from "./types.ts";

const nodule: Marker = { x_pct: 0.68, y_pct: 0.55, shape: "circle" };

test("teach reveals do not stay revealed when exam locate arms", () => {
  const taught = ["f_caselidcno_1", "f_caselidcno_2", "f_caselidcno_3"];
  assert.equal(
    locateModeArmed({
      examMode: true,
      findingId: "f_caselidcno_2",
      revealedIds: taught,
      marker: nodule,
    }),
    false
  );
  const plan = examEntryPlan({
    locatedIds: [],
    helpedIds: [],
    activeFindingId: "f_caselidcno_2",
  });
  assert.deepEqual(plan.revealedIds, []);
  assert.equal(plan.spoilActive, false);
  assert.equal(plan.phase, "idle");
  assert.equal(
    locateModeArmed({
      examMode: true,
      findingId: "f_caselidcno_2",
      revealedIds: plan.revealedIds,
      marker: nodule,
    }),
    true
  );
  assert.equal(examSpoilOnSeat(true, false), false);
  assert.equal(examSpoilOnSeat(true, true), true);
  assert.equal(examSpoilOnSeat(false, false), true);
});

test("exam entry keeps a located or helped finding and clears teach-only ids", () => {
  const plan = examEntryPlan({
    locatedIds: ["f_caselidcno_1"],
    helpedIds: ["f_caselidcno_3"],
    activeFindingId: "f_caselidcno_2",
  });
  assert.deepEqual(plan.revealedIds, ["f_caselidcno_1", "f_caselidcno_3"]);
  assert.equal(plan.spoilActive, false);
  const stayed = examEntryPlan({
    locatedIds: ["f_caselidcno_2"],
    helpedIds: [],
    activeFindingId: "f_caselidcno_2",
  });
  assert.equal(stayed.spoilActive, true);
  assert.equal(
    locateModeArmed({
      examMode: true,
      findingId: "f_caselidcno_2",
      revealedIds: stayed.revealedIds,
      marker: nodule,
    }),
    false
  );
});

test("interrupt clears a speaking or thinking lock", () => {
  assert.equal(phaseAfterInterrupt("speaking"), "idle");
  assert.equal(phaseAfterInterrupt("thinking"), "idle");
  assert.equal(phaseAfterInterrupt("transcribing"), "idle");
  assert.equal(phaseAfterInterrupt("recording"), "recording");
  assert.equal(phaseAfterInterrupt("idle"), "idle");
});

test("speaking and thinking do not drop a locate click after interrupt", () => {
  for (const stuck of ["speaking", "thinking"] as const) {
    const phase = phaseAfterInterrupt(stuck);
    assert.equal(phase, "idle");
    const duringLock = decideLocateClick({
      examMode: true,
      revealed: false,
      marker: nodule,
      x: 0.1,
      y: 0.1,
      misses: 0,
      phase: stuck,
    });
    assert.equal(duringLock.type, "miss");
    const after = decideLocateClick({
      examMode: true,
      revealed: false,
      marker: nodule,
      x: 0.68,
      y: 0.55,
      misses: 0,
      phase,
    });
    assert.equal(after.type, "hit");
  }
});

test("miss hints and a hit within the default radius", () => {
  const miss = decideLocateClick({
    examMode: true,
    revealed: false,
    marker: nodule,
    x: 0.1,
    y: 0.1,
    misses: 0,
    phase: "idle",
  });
  assert.equal(miss.type, "miss");
  if (miss.type === "miss") {
    assert.equal(miss.misses, 1);
    assert.match(miss.hint, /Not quite/);
  }
  const again = decideLocateClick({
    examMode: true,
    revealed: false,
    marker: nodule,
    x: 0.68 + 0.09,
    y: 0.55,
    misses: 1,
    phase: "thinking",
  });
  assert.equal(again.type, "miss");
  if (again.type === "miss") {
    assert.equal(again.misses, 2);
    assert.match(again.hint, /Still not it/);
  }
  const near = decideLocateClick({
    examMode: true,
    revealed: false,
    marker: nodule,
    x: 0.68 + 0.05,
    y: 0.55,
    misses: 2,
    phase: "speaking",
  });
  assert.equal(near.type, "hit");
  const shown = decideLocateClick({
    examMode: true,
    revealed: true,
    marker: nodule,
    x: 0.68,
    y: 0.55,
    misses: 0,
    phase: "idle",
  });
  assert.equal(shown.type, "ignore");
  assert.equal(
    decideLocateClick({
      examMode: false,
      revealed: false,
      marker: nodule,
      x: 0.68,
      y: 0.55,
      misses: 0,
      phase: "idle",
    }).type,
    "ignore"
  );
});

test("exam finding navigation stays open during thinking and speaking", () => {
  assert.equal(
    findingNavigationLocked({ examMode: true, phase: "thinking", ready: true }),
    false
  );
  assert.equal(
    findingNavigationLocked({ examMode: true, phase: "speaking", ready: true }),
    false
  );
  assert.equal(
    findingNavigationLocked({ examMode: true, phase: "idle", ready: true }),
    false
  );
  assert.equal(
    findingNavigationLocked({ examMode: false, phase: "thinking", ready: true }),
    true
  );
  assert.equal(
    findingNavigationLocked({ examMode: false, phase: "speaking", ready: true }),
    false
  );
  assert.equal(
    findingNavigationLocked({ examMode: true, phase: "transcribing", ready: true }),
    true
  );
  assert.equal(
    findingNavigationLocked({ examMode: true, phase: "recording", ready: true }),
    true
  );
  assert.equal(
    findingNavigationLocked({ examMode: true, phase: "idle", ready: false }),
    true
  );
});

test("hints below the reveal rung do not play the guide or drop the marker", () => {
  const kept = withholdUnrevealedExamActions(
    [
      { type: "play_guide", findingId: "f2" },
      { type: "point_to", findingId: "f2" },
      { type: "show_finding", findingId: "f2" },
      { type: "next_in_tour" },
      { type: "draw_annotation", findingId: "f2" },
      { type: "scroll_to", findingId: "f2" },
      { type: "set_window" },
    ],
    { examMode: true, hintLevel: 0, revealedIds: [], currentFindingId: "f2" }
  );
  assert.deepEqual(
    kept.map((action) => action.type),
    ["scroll_to", "set_window"]
  );
  const reveal = withholdUnrevealedExamActions(
    [{ type: "show_finding", findingId: "f2" }, { type: "play_guide", findingId: "f2" }],
    { examMode: true, hintLevel: 3, revealedIds: [], currentFindingId: "f2" }
  );
  assert.equal(reveal.length, 2);
  const already = withholdUnrevealedExamActions(
    [{ type: "point_to", findingId: "f2" }],
    { examMode: true, hintLevel: 1, revealedIds: ["f2"], currentFindingId: "f2" }
  );
  assert.equal(already.length, 1);
  const teach = withholdUnrevealedExamActions(
    [{ type: "play_guide", findingId: "f2" }],
    { examMode: false, hintLevel: 0, revealedIds: [], currentFindingId: "f2" }
  );
  assert.equal(teach.length, 1);
});

test("LIDC peripheral nodule survey locates after Teach", () => {
  const seed = JSON.parse(
    readFileSync(new URL("../seed/case-lidc-nodule-search.json", import.meta.url), "utf8")
  ) as { findings: Finding[] };
  const finding = seed.findings.find((item) => item.label === "Peripheral nodule survey");
  assert.ok(finding?.marker);
  assert.equal(finding?.marker?.x_pct, 0.68);
  assert.equal(finding?.marker?.y_pct, 0.55);
  const taught = seed.findings.map((item) => item.id);
  const plan = examEntryPlan({
    locatedIds: [],
    helpedIds: [],
    activeFindingId: finding?.id,
  });
  assert.equal(taught.includes(finding!.id), true);
  assert.equal(plan.revealedIds.includes(finding!.id), false);
  assert.equal(
    locateModeArmed({
      examMode: true,
      findingId: finding?.id,
      revealedIds: plan.revealedIds,
      marker: finding?.marker,
    }),
    true
  );
  const miss = decideLocateClick({
    examMode: true,
    revealed: false,
    marker: finding?.marker,
    x: 0.1,
    y: 0.1,
    misses: 0,
    phase: "speaking",
  });
  assert.equal(miss.type, "miss");
  const onMarker = decideLocateClick({
    examMode: true,
    revealed: false,
    marker: finding?.marker,
    x: 0.68,
    y: 0.55,
    misses: 0,
    phase: phaseAfterInterrupt("speaking"),
  });
  assert.equal(onMarker.type, "hit");
});
