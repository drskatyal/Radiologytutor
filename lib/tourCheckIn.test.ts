import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Finding, TeachingGuide } from "./types.ts";
import { playTeachingGuide } from "./replay.ts";
import {
  DONT_KNOW_OPTION,
  adaptRemainingFromState,
  branchAfterCheckIn,
  checkInFromModel,
  decisionBeatIndex,
  fallbackCheckIn,
  gradeCheckIn,
  leaksImageTarget,
  recordCheckIn,
  resolveCheckIn,
  type CheckInSource,
} from "./tourCheckIn.ts";

const seed = JSON.parse(
  readFileSync(new URL("../seed/case-lidc-nodule-search.json", import.meta.url), "utf8")
) as { findings: Finding[] };

const nodule = seed.findings[1] as Finding;

function optionText(source: CheckInSource): string {
  const check = fallbackCheckIn(source);
  assert.ok(check, source.id);
  return [check.prompt, check.affirm, check.correction, ...check.options].join("\n");
}

test("LIDC seed check-ins are text questions with a deterministic answer", () => {
  const indexes: number[] = [];
  for (const finding of seed.findings) {
    const check = fallbackCheckIn(finding);
    assert.ok(check, finding.label);
    assert.ok(check.options.length >= 3 && check.options.length <= 4, finding.label);
    assert.equal(check.options[check.options.length - 1], DONT_KNOW_OPTION);
    assert.notEqual(check.options[check.correctIndex], DONT_KNOW_OPTION);
    assert.equal(leaksImageTarget(optionText(finding)), false, finding.label);
    assert.doesNotMatch(optionText(finding), /0\.\d{2}/);
    indexes.push(check.correctIndex);
  }
  const lung = fallbackCheckIn(seed.findings[0]);
  const density = fallbackCheckIn(nodule);
  const mediastinum = fallbackCheckIn(seed.findings[2]);
  assert.match(lung?.prompt ?? "", /lobe/i);
  assert.match(density?.options.join(" ") ?? "", /Solid or subsolid/);
  assert.match(density?.prompt ?? "", /density/i);
  assert.match(mediastinum?.options.join(" ") ?? "", /granuloma/i);
  assert.ok(indexes.some((index) => index !== 0));
});

test("a rejected model payload falls back, and a clean one is kept", () => {
  const leaked = {
    prompt: "Click the nodule at 0.68, 0.55",
    options: ["Here", "There", "Elsewhere"],
    correctIndex: 0,
    affirm: "Yes.",
    correction: "No.",
  };
  assert.equal(checkInFromModel(leaked, nodule.id), null);
  const resolved = resolveCheckIn(nodule, leaked);
  assert.ok(resolved);
  assert.match(resolved.options.join(" "), /Solid or subsolid/);
  assert.equal(leaksImageTarget(resolved.prompt), false);

  const clean = {
    prompt: "Solid or subsolid before you measure?",
    options: ["Solid or subsolid", "Millimetres only", "Bone window"],
    correctIndex: 0,
    affirm: "Good.",
    correction: "Call the density first.",
  };
  const model = resolveCheckIn(nodule, clean);
  assert.equal(model?.prompt, clean.prompt);
  assert.equal(model?.options.at(-1), DONT_KNOW_OPTION);
  assert.equal(model?.options[model.correctIndex], "Solid or subsolid");
  assert.equal(resolveCheckIn({ id: "empty" }, { prompt: "nope" }), null);
});

test("grading and stored results replace the previous answer for that finding", () => {
  const check = fallbackCheckIn(nodule);
  assert.ok(check);
  assert.equal(gradeCheckIn(check, check.correctIndex), "correct");
  const wrong = check.options.findIndex((_, index) => index !== check.correctIndex && check.options[index] !== DONT_KNOW_OPTION);
  assert.equal(gradeCheckIn(check, wrong), "wrong");
  assert.equal(gradeCheckIn(check, check.options.length - 1), "unknown");
  assert.equal(gradeCheckIn(check, -1), "unknown");
  const once = recordCheckIn([], { findingId: nodule.id, result: "wrong", prompt: check.prompt });
  const twice = recordCheckIn(once, { findingId: nodule.id, result: "correct", prompt: check.prompt });
  const other = recordCheckIn(twice, { findingId: "other", result: "unknown", prompt: "Where?" });
  assert.equal(twice.length, 1);
  assert.equal(twice[0]?.result, "correct");
  assert.equal(other.length, 2);
});

test("a hit skips the pearl and a miss replays the authored lean-in", () => {
  const guide = nodule.teachingGuide as TeachingGuide;
  assert.equal(decisionBeatIndex(guide), guide.beats.findIndex((beat) => beat.act === "commit"));
  const check = fallbackCheckIn(nodule);
  assert.ok(check);
  const known = branchAfterCheckIn(guide, "correct", check);
  assert.deepEqual(known.skipActs, ["pearl"]);
  assert.deepEqual(known.preface[0]?.actions, []);
  assert.match(known.preface[0]?.say ?? "", /Solid or subsolid/);

  const missed = recordCheckIn([], { findingId: nodule.id, result: "wrong", prompt: check.prompt });
  const again = adaptRemainingFromState(guide, missed, nodule.id, check);
  assert.ok(again);
  assert.deepEqual(again.skipActs, []);
  assert.equal(again.preface[0]?.act, "lean-in");
  assert.deepEqual(again.preface[0]?.actions, [
    { type: "zoom", zoom: 1, pan: [0, 0] },
    { type: "zoom", zoom: 2.2, pan: [0, 0] },
  ]);
  const unknown = branchAfterCheckIn(guide, "unknown", check);
  assert.equal(unknown.preface[0]?.act, "lean-in");
  assert.deepEqual(unknown.skipActs, []);

  const storedHit = recordCheckIn(missed, {
    findingId: nodule.id,
    result: "correct",
    prompt: check.prompt,
  });
  const adapted = adaptRemainingFromState(guide, storedHit, nodule.id, check);
  assert.deepEqual(adapted?.skipActs, ["pearl"]);
  assert.equal(adaptRemainingFromState(guide, [], nodule.id, check), null);
});

test("an explicit decision wins, and a guide with no commit does not pause", () => {
  const marked: TeachingGuide = {
    durationMs: 100,
    start: { sliceIndex: 0 },
    beats: [
      { t: 0, act: "search", decision: true, actions: [], say: "Which window?" },
      { t: 10, act: "commit", actions: [], say: "Look here." },
    ],
  };
  assert.equal(decisionBeatIndex(marked), 0);
  const bare: TeachingGuide = {
    durationMs: 10,
    start: { sliceIndex: 0 },
    beats: [{ t: 0, act: "pearl", actions: [], say: "Name it." }],
  };
  assert.equal(decisionBeatIndex(bare), null);
  const noZoom: TeachingGuide = {
    durationMs: 10,
    start: { sliceIndex: 0 },
    beats: [
      { t: 0, act: "commit", actions: [{ type: "point", x: 0.2, y: 0.2 }], say: "Look here." },
    ],
  };
  const spoken = branchAfterCheckIn(noZoom, "wrong", {
    affirm: "Good.",
    correction: "Not quite.",
  });
  assert.deepEqual(spoken.preface[0]?.actions, []);
  assert.equal(spoken.preface[0]?.say, "Not quite.");
});

const script: TeachingGuide = {
  durationMs: 1600,
  start: { sliceIndex: 41, ww: 1500, wc: -600 },
  beats: [
    {
      t: 0,
      act: "orient",
      say: "Follow the stack.",
      actions: [{ type: "scroll", sliceIndex: 49 }],
    },
    {
      t: 10,
      act: "search",
      say: "Lung windows.",
      actions: [{ type: "window", ww: 1500, wc: -600 }],
    },
    {
      t: 20,
      act: "lean-in",
      say: "Lean in.",
      actions: [{ type: "zoom", zoom: 2.2, pan: [0.1, -0.2] }],
    },
    {
      t: 30,
      act: "commit",
      say: "Look here.",
      actions: [{ type: "point", x: 0.68, y: 0.55 }],
    },
    { t: 40, act: "pearl", say: "Note solid versus subsolid.", actions: [] },
  ],
};

function driveScript(
  onCheckIn: NonNullable<Parameters<typeof playTeachingGuide>[2]>["onCheckIn"]
) {
  const said: string[] = [];
  const zooms: Array<{ zoom?: number; pan?: [number, number] }> = [];
  let points = 0;
  const ctrl = playTeachingGuide(
    script,
    {
      applyEvent: () => undefined,
      setWindow: async () => undefined,
      showState: async (state) => {
        if (state.zoom != null) zooms.push({ zoom: state.zoom, pan: state.pan });
      },
      overlay: {
        cursor: () => {
          points += 1;
        },
      },
    },
    {
      timeScale: 0,
      narrate: async (text) => {
        said.push(text);
      },
      onCheckIn: async (ctx) => {
        assert.equal(points, 0, "the pointer waits until the answer");
        assert.equal(ctx.beat.act, "commit");
        return onCheckIn?.(ctx);
      },
    }
  );
  return { ctrl, said, zooms, points: () => points };
}

test("playTeachingGuide asks once, then a hit skips the pearl and leaves the anchor", async () => {
  const { ctrl, said, zooms, points } = driveScript(async () =>
    branchAfterCheckIn(script, "correct", { affirm: "Good call.", correction: "Look again." })
  );
  await ctrl.finished;
  assert.match(said.join(" "), /Good call/);
  assert.match(said.join(" "), /Look here/);
  assert.doesNotMatch(said.join(" "), /subsolid/);
  assert.equal(points(), 1);
  assert.deepEqual(
    zooms.map((item) => item.zoom),
    [1, 2.2]
  );
});

test("a miss leans in with the authored pan, then reveals and keeps the pearl", async () => {
  const { ctrl, said, zooms, points } = driveScript(async () =>
    branchAfterCheckIn(script, "wrong", { affirm: "Good call.", correction: "Look again at the edge." })
  );
  await ctrl.finished;
  assert.match(said.join(" "), /Look again at the edge/);
  assert.match(said.join(" "), /Look here/);
  assert.match(said.join(" "), /subsolid/);
  assert.equal(points(), 1);
  assert.deepEqual(zooms, [
    { zoom: 1, pan: [0, 0] },
    { zoom: 2.2, pan: [0.1, -0.2] },
    { zoom: 1, pan: [0, 0] },
    { zoom: 2.2, pan: [0.1, -0.2] },
  ]);
});

test("pausing during the check-in does not reveal the pointer", async () => {
  let waiting = false;
  let points = 0;
  const ctrl = playTeachingGuide(
    script,
    {
      applyEvent: () => undefined,
      showState: async () => undefined,
      setWindow: async () => undefined,
      overlay: {
        cursor: () => {
          points += 1;
        },
      },
    },
    {
      timeScale: 0,
      narrate: async () => undefined,
      onCheckIn: () => {
        waiting = true;
        return new Promise(() => undefined);
      },
    }
  );
  for (let i = 0; i < 40 && !waiting; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(waiting, true);
  assert.equal(points, 0);
  ctrl.cancel();
  await ctrl.finished;
  assert.equal(points, 0);
  assert.equal(ctrl.done, true);
});
