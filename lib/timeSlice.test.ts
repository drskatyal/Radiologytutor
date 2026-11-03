import assert from "node:assert/strict";
import { test } from "node:test";
import { runSliced, runToCompletion, yieldToEventLoop, type SliceStats } from "../packages/viewer-core/src/timeSlice";
import {
  groupLocalStudies,
  groupLocalStudiesSteps,
  type LocalInstanceHeader,
} from "../packages/viewer-core/src/localStudy";

function* counted(steps: number, log: string[]) {
  for (let i = 0; i < steps; i += 1) {
    log.push(`step ${i}`);
    yield;
  }
  return steps;
}

test("runToCompletion runs every step and returns the result", () => {
  const log: string[] = [];
  assert.equal(runToCompletion(counted(5, log)), 5);
  assert.equal(log.length, 5);
});

test("runSliced gives the thread back each time a slice uses its budget", async () => {
  let clock = 0;
  const log: string[] = [];
  let stats: SliceStats | undefined;
  const work = (function* () {
    for (let i = 0; i < 10; i += 1) {
      clock += 3; // each step costs 3 ms
      log.push(`step ${i}`);
      yield;
    }
    return "done";
  })();
  const result = await runSliced(work, {
    budgetMs: 8,
    now: () => clock,
    yieldFn: async () => void log.push("yield"),
    onStats: (s) => (stats = s),
  });
  assert.equal(result, "done");
  // 3 steps (9 ms) per slice: the budget is checked after each step.
  assert.deepEqual(
    log.filter((l) => l === "yield").length,
    3
  );
  assert.equal(log.indexOf("yield"), 3);
  assert.deepEqual(stats, { slices: 4, maxSliceMs: 9, busyMs: 30 });
});

test("runSliced never yields when the work fits one slice", async () => {
  let yields = 0;
  const result = await runSliced(counted(50, []), { budgetMs: 1_000, yieldFn: async () => void (yields += 1) });
  assert.equal(result, 50);
  assert.equal(yields, 0);
});

test("runSliced stops cancelled work at its next step", async () => {
  const log: string[] = [];
  let cancelled = false;
  let finished = false;
  const work = (function* () {
    try {
      yield* counted(10, log);
    } finally {
      finished = true;
    }
    return 1;
  })();
  const result = await runSliced(work, {
    budgetMs: 0,
    yieldFn: async () => {
      if (log.length === 3) cancelled = true;
    },
    isCancelled: () => cancelled,
  });
  assert.equal(result, undefined);
  assert.equal(log.length, 3);
  assert.equal(finished, true, "the generator is closed (its finally ran)");
});

test("yieldToEventLoop resumes after a macrotask, not as a microtask", async () => {
  const order: string[] = [];
  setTimeout(() => order.push("timer"), 0);
  await new Promise((r) => setTimeout(r, 1)); // let the timer queue settle
  const pending = yieldToEventLoop().then(() => order.push("resumed"));
  void Promise.resolve().then(() => order.push("microtask"));
  await pending;
  assert.deepEqual(order, ["timer", "microtask", "resumed"]);
});

test("groupLocalStudiesSteps is groupLocalStudies, cut into steps", () => {
  const headers: LocalInstanceHeader[] = [];
  for (let s = 0; s < 30; s += 1) {
    for (let i = 0; i < 120; i += 1) {
      headers.push({
        fileName: `S${s}/IM${(i * 37) % 120}`,
        sizeBytes: 1,
        studyInstanceUID: s < 20 ? "1.1" : "1.2",
        studyDate: s < 20 ? "20240101" : "20250101",
        seriesInstanceUID: `1.${s}`,
        seriesNumber: (s * 7) % 30,
        instanceNumber: (i * 37) % 120,
        imageOrientationPatient: [1, 0, 0, 0, 1, 0],
        imagePositionPatient: [0, 0, ((i * 37) % 120) * 1.25],
      });
    }
  }
  const work = groupLocalStudiesSteps(headers);
  let steps = 0;
  let step = work.next();
  while (!step.done) {
    steps += 1;
    step = work.next();
  }
  // 3,600 headers: 3 chunks of 1,024 in the first pass, then one per series.
  assert.equal(steps, 3 + 30);
  assert.deepEqual(step.value, groupLocalStudies(headers));
  assert.deepEqual(
    step.value.map((st) => st.studyInstanceUID),
    ["1.2", "1.1"]
  );
});
