import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTENDING_HOLD_MAX_MS,
  attendingGapMs,
  interruptGuidePlayback,
  planSliceWalk,
  playTeachingGuide,
  SCROLL_WALK_MAX_STEPS,
  startReplay,
} from "./replay.ts";
import { displaySliceNumber } from "./findingDisplayState.ts";
import { voiNear } from "./viewportVoi.ts";
import { commitAnnotatedFinding, commitSpeakOnceWithoutMic, resolveTeachingGuide } from "./teachingGuide.ts";
import type { RecordedEvent, RecordedTrack, TeachingGuide } from "./types.ts";

// --- A controllable fake clock + rAF so replay is deterministic in node. ----
class FakeClock {
  now = 0;
  private queue: ((t: number) => void)[] = [];

  install() {
    const g = globalThis as unknown as {
      performance: { now: () => number };
      requestAnimationFrame: (cb: (t: number) => void) => number;
      cancelAnimationFrame: (id: number) => void;
    };
    g.performance = { now: () => this.now };
    g.requestAnimationFrame = (cb) => {
      this.queue.push(cb);
      return this.queue.length;
    };
    g.cancelAnimationFrame = () => {};
  }

  /** Advance the clock to `ms` and flush the rAF queue at that time. */
  advance(ms: number) {
    this.now = ms;
    const q = this.queue;
    this.queue = [];
    for (const cb of q) cb(this.now);
  }
}

function track(events: RecordedEvent[], durationMs: number): RecordedTrack {
  return { durationMs, start: { sliceIndex: 2, ww: 80, wc: 40 }, events };
}

test("primes the start state before any event fires", () => {
  const clock = new FakeClock();
  clock.install();
  const applied: RecordedEvent[] = [];
  startReplay(
    track([], 100),
    { applyEvent: (e) => applied.push(e), getStartState: () => ({ sliceIndex: 0 }) },
    {}
  );
  // Priming happens synchronously at startReplay time.
  assert.deepEqual(
    applied.map((e) => e.type),
    ["slice", "voi"]
  );
  assert.equal((applied[0] as { index: number }).index, 2);
});

test("fires events in recorded order as the clock advances", () => {
  const clock = new FakeClock();
  clock.install();
  const applied: RecordedEvent[] = [];
  const events: RecordedEvent[] = [
    { t: 10, type: "slice", index: 3 },
    { t: 20, type: "voi", ww: 100, wc: 50 },
    { t: 40, type: "camera", zoom: 2, pan: [1, 1] },
  ];
  startReplay(
    track(events, 50),
    { applyEvent: (e) => applied.push(e), getStartState: () => ({ sliceIndex: 0 }) },
    {}
  );
  applied.length = 0; // drop priming events

  clock.advance(15); // fires t<=15 -> slice@10
  assert.deepEqual(applied.map((e) => e.t), [10]);
  clock.advance(25); // fires voi@20
  assert.deepEqual(applied.map((e) => e.t), [10, 20]);
  clock.advance(50); // fires camera@40
  assert.deepEqual(applied.map((e) => e.t), [10, 20, 40]);
});

test("routes cursor/annotation to the overlay, not the viewer", () => {
  const clock = new FakeClock();
  clock.install();
  const applied: RecordedEvent[] = [];
  const cursors: number[][] = [];
  let annotations = 0;
  const events: RecordedEvent[] = [
    { t: 5, type: "cursor", x: 0.5, y: 0.5 },
    { t: 6, type: "slice", index: 4 },
    { t: 7, type: "annotation", shape: "arrow", from: [0, 0], to: [1, 1] },
  ];
  startReplay(
    track(events, 10),
    { applyEvent: (e) => applied.push(e), getStartState: () => ({ sliceIndex: 0 }) },
    {
      overlay: {
        cursor: (x, y) => cursors.push([x, y]),
        annotation: () => annotations++,
        clear: () => {},
      },
    }
  );
  applied.length = 0;
  clock.advance(10);
  assert.deepEqual(cursors, [[0.5, 0.5]]);
  assert.equal(annotations, 1);
  // Only the slice event went to the viewer.
  assert.deepEqual(applied.map((e) => e.type), ["slice"]);
});

test("routes a series event to the viewer (applyEvent), not the overlay", () => {
  const clock = new FakeClock();
  clock.install();
  const applied: RecordedEvent[] = [];
  let cursors = 0;
  const events: RecordedEvent[] = [
    { t: 5, type: "series", seriesInstanceUID: "1.2.3.series" },
    { t: 6, type: "slice", index: 2 },
  ];
  startReplay(
    track(events, 10),
    { applyEvent: (e) => applied.push(e), getStartState: () => ({ sliceIndex: 0 }) },
    { overlay: { cursor: () => cursors++, annotation: () => {}, clear: () => {} } }
  );
  applied.length = 0; // drop priming events
  clock.advance(10);
  assert.deepEqual(
    applied.map((e) => e.type),
    ["series", "slice"]
  );
  assert.equal(
    (applied[0] as { seriesInstanceUID: string }).seriesInstanceUID,
    "1.2.3.series"
  );
  assert.equal(cursors, 0);
});

test("locks to audio.currentTime when an audio element is supplied", () => {
  const clock = new FakeClock();
  clock.install();
  const applied: RecordedEvent[] = [];
  // Audio is at 0.03s = 30ms regardless of the wall clock.
  const audio = { currentTime: 0.03 } as HTMLAudioElement;
  const events: RecordedEvent[] = [
    { t: 25, type: "slice", index: 1 },
    { t: 50, type: "slice", index: 2 },
  ];
  startReplay(
    track(events, 60),
    { applyEvent: (e) => applied.push(e), getStartState: () => ({ sliceIndex: 0 }) },
    { audio }
  );
  applied.length = 0;
  clock.advance(9999); // wall clock is huge, but audio says 30ms
  // Only the 25ms event has arrived per the audio clock.
  assert.deepEqual(applied.map((e) => e.t), [25]);
});

test("calls onEnd once the clock passes the duration", () => {
  const clock = new FakeClock();
  clock.install();
  let ended = 0;
  startReplay(
    track([{ t: 5, type: "slice", index: 1 }], 20),
    { applyEvent: () => {}, getStartState: () => ({ sliceIndex: 0 }) },
    { onEnd: () => ended++ }
  );
  clock.advance(10); // not done yet
  assert.equal(ended, 0);
  clock.advance(25); // past duration AND all events fired
  assert.equal(ended, 1);
});

test("playTeachingGuide drives while the line is still speaking and primes the next say", async () => {
  const order: string[] = [];
  let releaseFirst: (() => void) | null = null;
  let said = 0;
  const guide: TeachingGuide = {
    durationMs: 800,
    start: { sliceIndex: 2 },
    beats: [
      {
        t: 0,
        act: "search",
        say: "Lung windows.",
        actions: [{ type: "window", ww: 1500, wc: -600 }],
      },
      {
        t: 10,
        act: "lean-in",
        say: "Lean in.",
        actions: [{ type: "zoom", zoom: 2.2, pan: [0, 0] }],
      },
    ],
  };
  const ctrl = playTeachingGuide(
    guide,
    {
      applyEvent: (event) => {
        if (event.type === "voi") order.push("window");
      },
      setWindow: async () => {
        order.push("window");
      },
      showState: async (state) => {
        if (state.zoom != null && state.zoom > 1) order.push("zoom");
      },
    },
    {
      timeScale: 0,
      primeNarration: (text) => order.push(`prime:${text}`),
      narrate: (text) => {
        order.push(`say:${text}`);
        said += 1;
        if (said > 1) return Promise.resolve();
        return new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      },
    }
  );
  for (let i = 0; i < 20 && !order.includes("prime:Lean in."); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(order.indexOf("window") < order.indexOf("say:Lung windows."), order.join(" | "));
  assert.ok(order.indexOf("say:Lung windows.") < order.indexOf("prime:Lean in."), order.join(" | "));
  assert.equal(order.includes("zoom"), false, order.join(" | "));
  releaseFirst?.();
  await ctrl.finished;
  assert.ok(order.includes("zoom"));
  assert.ok(order.indexOf("say:Lung windows.") < order.indexOf("zoom"));
});

test("playTeachingGuide scrolls, tweens window and zoom, and draws a missed stroke", async () => {
  const applied: string[] = [];
  let slice = 0;
  const said: string[] = [];
  const guide: TeachingGuide = {
    durationMs: 2000,
    start: { sliceIndex: 4, ww: 1500, wc: -600 },
    beats: [
      {
        t: 100,
        say: "Look here.",
        actions: [
          { type: "scroll", sliceIndex: 6 },
          { type: "window", ww: 400, wc: 40 },
          { type: "zoom", zoom: 1.6, pan: [0, 0] },
          {
            type: "annotate",
            shape: "arrow",
            from: [0.2, 0.2],
            to: [0.4, 0.4],
            tool: "Length",
            handles: [
              [0.2, 0.2],
              [0.4, 0.4],
            ],
          },
        ],
      },
    ],
  };
  const ctrl = playTeachingGuide(
    guide,
    {
      applyEvent: (e) => {
        applied.push(e.type);
        if (e.type === "slice") slice = e.index;
      },
      getSliceIndex: () => slice,
      settle: async () => {},
      setWindow: async () => {
        applied.push("tween-voi");
      },
      showState: async () => {
        applied.push("tween-zoom");
      },
      annotationLanded: () => false,
      overlay: {
        annotation: () => applied.push("overlay-ann"),
        cursor: () => {},
        clear: () => {},
      },
    },
    {
      narrate: async (text) => {
        said.push(text);
      },
      sliceStepMs: 0,
      timeScale: 0,
    }
  );
  await ctrl.finished;
  assert.deepEqual(said, ["Look here."]);
  assert.equal(slice, 6);
  assert.ok(applied.includes("tween-voi"));
  assert.ok(applied.includes("tween-zoom"));
  assert.ok(applied.includes("annotation"));
  assert.ok(applied.includes("overlay-ann"));
});

test("blank say lines do not call narrate, and a TTS rejection still finishes", async () => {
  const said: string[] = [];
  let ended = 0;
  const guide: TeachingGuide = {
    durationMs: 1000,
    start: { sliceIndex: 1 },
    beats: [
      { t: 0, say: "   ", actions: [{ type: "scroll", sliceIndex: 2 }] },
      { t: 10, say: "Follow the stack.", actions: [] },
      { t: 20, say: "Name the pleural line.", actions: [] },
    ],
  };
  const ctrl = playTeachingGuide(
    guide,
    {
      applyEvent: () => {},
      getSliceIndex: () => 2,
    },
    {
      timeScale: 0,
      narrate: async (text) => {
        said.push(text);
        if (text.startsWith("Follow")) throw new Error("tts down");
      },
      onEnd: () => {
        ended += 1;
      },
    }
  );
  await ctrl.finished;
  assert.deepEqual(said, ["Follow the stack.", "Name the pleural line."]);
  assert.equal(ended, 1);
  assert.equal(ctrl.done, true);
});

function noduleGuide(): TeachingGuide {
  return {
    durationMs: 2000,
    start: { sliceIndex: 0 },
    beats: [
      {
        t: 0,
        act: "orient",
        say: "Follow the stack.",
        actions: [{ type: "scroll", sliceIndex: 27, seriesInstanceUID: "1.2.3" }],
      },
      {
        t: 10,
        act: "commit",
        say: "Look here.",
        actions: [{ type: "point", x: 0.4, y: 0.5 }],
      },
      {
        t: 20,
        act: "pearl",
        say: "This is a nodule.",
        actions: [],
      },
    ],
  };
}

test("playTeachingGuide stays linear when the learner follows the scroll", async () => {
  let slice = 0;
  const said: string[] = [];
  const ctrl = playTeachingGuide(
    noduleGuide(),
    {
      applyEvent: (e) => {
        if (e.type === "slice") slice = e.index;
      },
      getSliceIndex: () => slice,
      settle: async () => {},
    },
    {
      timeScale: 0,
      narrate: async (text) => {
        said.push(text);
      },
      landmark: "carina",
      withholdTerms: ["nodule"],
    }
  );
  await ctrl.finished;
  assert.deepEqual(said, ["Follow the stack.", "Look here.", "This is a nodule."]);
  assert.equal(slice, 27);
});

test("playTeachingGuide re-seats a learner who is far from the money slice", async () => {
  let here = 0;
  const said: string[] = [];
  const scrolled: number[] = [];
  const ctrl = playTeachingGuide(
    noduleGuide(),
    {
      applyEvent: (e) => {
        if (e.type === "slice") scrolled.push(e.index);
        if (e.type === "series") scrolled.push(-1);
      },
      // Stuck off-slice until the hint is spoken, then they follow it.
      getSliceIndex: () => here,
      settle: async () => {},
    },
    {
      timeScale: 0,
      landmark: "carina",
      withholdTerms: ["nodule"],
      narrate: async (text) => {
        said.push(text);
        if (text.includes("too high") || text.includes("too low")) here = 27;
      },
    }
  );
  await ctrl.finished;
  const hint = said.find((line) => /too high|too low/.test(line));
  assert.ok(hint);
  assert.match(hint!, /too high/);
  assert.match(hint!, /carina/);
  assert.doesNotMatch(hint!, /nodule/i);
  assert.deepEqual(said, [
    "Follow the stack.",
    hint!,
    "Look here.",
    "This is a nodule.",
  ]);
  assert.ok(scrolled.includes(-1));
  assert.equal(scrolled.at(-1), 27);
});

test("a landmark that contains the finding label is not spoken on the re-seat", async () => {
  let here = 0;
  const said: string[] = [];
  const ctrl = playTeachingGuide(
    noduleGuide(),
    {
      applyEvent: () => {},
      getSliceIndex: () => here,
    },
    {
      timeScale: 0,
      landmark: "spiculated nodule",
      withholdTerms: ["nodule"],
      narrate: async (text) => {
        said.push(text);
        if (/too high|too low/.test(text)) here = 27;
      },
    }
  );
  await ctrl.finished;
  const hint = said.find((line) => /too high|too low/.test(line)) ?? "";
  assert.match(hint, /level we're teaching/);
  assert.doesNotMatch(hint, /nodule/i);
});

test("eight slices away is still on the script, and adaptive can be turned off", async () => {
  const said: string[] = [];
  const close = playTeachingGuide(
    noduleGuide(),
    {
      applyEvent: () => {},
      getSliceIndex: () => 19,
    },
    {
      timeScale: 0,
      narrate: async (text) => {
        said.push(text);
      },
    }
  );
  await close.finished;
  assert.deepEqual(said, ["Follow the stack.", "Look here.", "This is a nodule."]);

  said.length = 0;
  const off = playTeachingGuide(
    noduleGuide(),
    {
      applyEvent: () => {},
      getSliceIndex: () => 0,
    },
    {
      timeScale: 0,
      adaptive: false,
      narrate: async (text) => {
        said.push(text);
      },
    }
  );
  await off.finished;
  assert.deepEqual(said, ["Follow the stack.", "Look here.", "This is a nodule."]);
});

test("a narration that ends is awaited before the next beat", async () => {
  const order: string[] = [];
  const guide: TeachingGuide = {
    durationMs: 100,
    start: { sliceIndex: 0 },
    beats: [
      { t: 0, say: "Orient.", actions: [{ type: "scroll", sliceIndex: 2 }] },
      { t: 10, say: "Pearl.", actions: [] },
    ],
  };
  const ctrl = playTeachingGuide(
    guide,
    { applyEvent: () => {}, getSliceIndex: () => 2 },
    {
      timeScale: 0,
      narrationHoldMs: () => 500,
      narrate: async (text) => {
        order.push(`start:${text}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(`end:${text}`);
      },
    }
  );
  await ctrl.finished;
  assert.deepEqual(order, ["start:Orient.", "end:Orient.", "start:Pearl.", "end:Pearl."]);
});

test("a narration that never returns still plays every later beat", async () => {
  const said: string[] = [];
  const applied: string[] = [];
  let slice = 0;
  const guide: TeachingGuide = {
    durationMs: 1600,
    start: { sliceIndex: 0 },
    beats: [
      {
        t: 0,
        act: "orient",
        say: "Follow the stack.",
        actions: [{ type: "scroll", sliceIndex: 34 }],
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
        actions: [{ type: "zoom", zoom: 2.2, pan: [0, 0] }],
      },
      {
        t: 30,
        act: "commit",
        say: "Look here.",
        actions: [{ type: "point", x: 0.52, y: 0.42 }],
      },
      { t: 40, act: "pearl", say: "Name the pattern.", actions: [] },
    ],
  };
  const ctrl = playTeachingGuide(
    guide,
    {
      applyEvent: (event) => {
        applied.push(event.type);
        if (event.type === "slice") slice = event.index;
      },
      getSliceIndex: () => slice,
      settle: async () => {},
      setWindow: async (ww, wc) => {
        applied.push(`window:${ww}/${wc}`);
      },
      showState: async (state) => {
        if (state.zoom != null) applied.push(`zoom:${state.zoom}`);
      },
      overlay: {
        animateTo: async (x, y) => {
          applied.push(`point:${x},${y}`);
        },
      },
    },
    {
      timeScale: 0,
      narrationHoldMs: () => 20,
      narrate: (text) => {
        said.push(text);
        return new Promise(() => {});
      },
    }
  );
  await ctrl.finished;
  assert.deepEqual(said, [
    "Follow the stack.",
    "Lung windows.",
    "Lean in.",
    "Look here.",
    "Name the pattern.",
  ]);
  assert.equal(slice, 34);
  assert.ok(applied.includes("window:1500/-600"));
  assert.ok(applied.indexOf("zoom:1") < applied.indexOf("zoom:2.2"));
  assert.ok(applied.includes("point:0.52,0.42"));
  assert.equal(ctrl.done, true);
});

test("cancel unblocks a guide waiting on narration", async () => {
  let started = 0;
  const guide: TeachingGuide = {
    durationMs: 5000,
    start: { sliceIndex: 1 },
    beats: [
      { t: 400, say: "Hold.", actions: [{ type: "scroll", sliceIndex: 3 }] },
      { t: 800, say: "Next.", actions: [] },
    ],
  };
  const ctrl = playTeachingGuide(
    guide,
    { applyEvent: () => {}, getSliceIndex: () => 1 },
    {
      timeScale: 1,
      narrationHoldMs: () => 60_000,
      narrate: () => {
        started += 1;
        return new Promise(() => {});
      },
    }
  );
  setTimeout(() => ctrl.cancel(), 30);
  await ctrl.finished;
  assert.equal(ctrl.done, true);
  assert.equal(started, 0);
});

test("planSliceWalk steps toward the target and lands on it", () => {
  const down = planSliceWalk(0, 49);
  assert.ok(down.length >= 3);
  assert.ok(down.length <= SCROLL_WALK_MAX_STEPS);
  assert.equal(down[0] > 0 && down[0] < 49, true);
  assert.equal(down[down.length - 1], 49);
  for (let i = 1; i < down.length; i++) assert.ok(down[i] > down[i - 1]);

  const up = planSliceWalk(40, 12);
  assert.equal(up[up.length - 1], 12);
  for (let i = 1; i < up.length; i++) assert.ok(up[i] < up[i - 1]);

  assert.deepEqual(planSliceWalk(8, 8), [8]);
  assert.deepEqual(planSliceWalk(5, 6), [6]);
});

test("a long scripted gap becomes an attending hold, not dead air", () => {
  assert.equal(attendingGapMs(25_000, 0), ATTENDING_HOLD_MAX_MS);
  assert.ok(ATTENDING_HOLD_MAX_MS >= 1_000);
  assert.ok(ATTENDING_HOLD_MAX_MS <= 3_000);
  assert.equal(attendingGapMs(25_000, 5_000), 0);
  assert.equal(attendingGapMs(400, 0), 400);
  assert.equal(attendingGapMs(400, 2_000), 0);
  assert.equal(attendingGapMs(0, 0), 0);
});

test("search walks intermediate slices; commit does not scroll again", async () => {
  const log: string[] = [];
  let slice = 0;
  let ww = 400;
  let wc = 40;
  const guide: TeachingGuide = {
    durationMs: 1600,
    start: { sliceIndex: 0 },
    beats: [
      {
        t: 0,
        act: "orient",
        say: "Follow the stack.",
        actions: [{ type: "scroll", sliceIndex: 40, seriesInstanceUID: "1.2.3" }],
      },
      {
        t: 400,
        act: "search",
        say: "Lung windows. Walk the lungs.",
        actions: [{ type: "window", ww: 1500, wc: -600 }],
      },
      {
        t: 800,
        act: "lean-in",
        say: "Stay on this slice and look at the edge.",
        actions: [{ type: "zoom", zoom: 2.2, pan: [0, 0] }],
      },
      {
        t: 1200,
        act: "commit",
        say: "Look here.",
        actions: [{ type: "point", x: 0.4, y: 0.5 }],
      },
    ],
  };
  const ctrl = playTeachingGuide(
    guide,
    {
      applyEvent: (event) => {
        if (event.type === "slice") {
          slice = event.index;
          // A slice load writes the DICOM soft-tissue window back. The
          // window action after the landing slice has to put lung back.
          ww = 400;
          wc = 40;
          log.push(`slice:${event.index}`);
        } else if (event.type === "series") {
          log.push("series");
        }
      },
      getSliceIndex: () => slice,
      settle: async () => {},
      setWindow: async (w, c) => {
        ww = w;
        wc = c;
        log.push(`window:${w}/${c}`);
      },
      showState: async (state) => {
        if (state.zoom != null) log.push(`zoom:${state.zoom}`);
      },
      overlay: {
        animateTo: async () => {
          log.push("point");
        },
      },
    },
    {
      timeScale: 0,
      narrate: async (text) => {
        log.push(`say:${text}`);
        if (text.startsWith("Lung windows")) {
          assert.ok(voiNear({ ww, wc }, { ww: 1500, wc: -600 }), `${ww}/${wc}`);
        }
      },
    }
  );
  await ctrl.finished;
  const lung = log.indexOf("say:Lung windows. Walk the lungs.");
  const money = log.indexOf("slice:40");
  const windowAt = log.lastIndexOf("window:1500/-600");
  const pointAt = log.indexOf("point");
  assert.ok(lung >= 0 && money > lung, log.join(" | "));
  assert.ok(windowAt > money, log.join(" | "));
  assert.ok(pointAt > windowAt, log.join(" | "));
  const walked = log.filter((line) => line.startsWith("slice:")).map((line) => Number(line.slice(6)));
  const mid = walked.filter((index) => index > 0 && index < 40);
  assert.ok(mid.length >= 1, walked.join(","));
  assert.equal(walked[walked.length - 1], 40);
  assert.equal(
    log.slice(windowAt).some((line) => line.startsWith("slice:")),
    false,
    log.join(" | ")
  );
  assert.equal(ww, 1500);
  assert.equal(wc, -600);
});

test("commit annotation lands on its slice without stepping the stack", async () => {
  const slices: number[] = [];
  let slice = 3;
  const guide: TeachingGuide = {
    durationMs: 200,
    start: { sliceIndex: 3 },
    beats: [
      {
        t: 0,
        act: "commit",
        say: "Look here.",
        actions: [
          {
            type: "annotate",
            sliceIndex: 18,
            shape: "arrow",
            from: [0.2, 0.3],
            to: [0.4, 0.5],
            tool: "Length",
            handles: [
              [0.2, 0.3],
              [0.4, 0.5],
            ],
          },
        ],
      },
    ],
  };
  const ctrl = playTeachingGuide(
    guide,
    {
      applyEvent: (event) => {
        if (event.type === "slice") {
          slice = event.index;
          slices.push(event.index);
        }
      },
      getSliceIndex: () => slice,
      settle: async () => {},
      annotationLanded: () => true,
    },
    { timeScale: 0, narrate: async () => {} }
  );
  await ctrl.finished;
  assert.deepEqual(slices, [3, 18]);
});

test("playTeachingGuide does not sit out a 25s scripted gap", async () => {
  const guide: TeachingGuide = {
    durationMs: 30_000,
    start: { sliceIndex: 1 },
    beats: [
      { t: 0, say: "Stay on this slice and look at the edge.", actions: [] },
      { t: 25_000, say: "Look here.", actions: [] },
    ],
  };
  const started = Date.now();
  const ctrl = playTeachingGuide(
    guide,
    { applyEvent: () => {}, getSliceIndex: () => 1 },
    {
      timeScale: 1,
      narrationHoldMs: () => 0,
      narrate: async () => {},
    }
  );
  await ctrl.finished;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4_500, `elapsed ${elapsed}`);
  assert.ok(elapsed >= ATTENDING_HOLD_MAX_MS - 200, `elapsed ${elapsed}`);
});

test("cancel during in-flight narration does not speak the next beat", async () => {
  const said: string[] = [];
  let release: () => void = () => {};
  let interrupts = 0;
  const guide: TeachingGuide = {
    durationMs: 2000,
    start: { sliceIndex: 0 },
    beats: [
      {
        t: 0,
        act: "orient",
        say: "Follow the stack.",
        actions: [{ type: "scroll", sliceIndex: 4 }],
      },
      {
        t: 400,
        act: "search",
        say: "Lung windows. Notice what the lung window was hiding.",
        actions: [],
      },
    ],
  };
  const ctrl = playTeachingGuide(
    guide,
    { applyEvent: () => {}, getSliceIndex: () => 0, settle: async () => {} },
    {
      timeScale: 0,
      onInterrupt: () => {
        interrupts += 1;
      },
      narrate: (text) => {
        said.push(text);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(said, ["Follow the stack."]);
  ctrl.cancel();
  assert.equal(interrupts, 1);
  assert.equal(ctrl.done, true);
  await ctrl.finished;
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(said, ["Follow the stack."]);
});

test("handoff to a notes guide drops the previous look-cue", async () => {
  const said: string[] = [];
  let release: () => void = () => {};
  const stops: string[] = [];
  const previous: TeachingGuide = {
    durationMs: 1600,
    start: { sliceIndex: 0 },
    beats: [
      {
        t: 0,
        act: "orient",
        say: "Follow the stack.",
        actions: [{ type: "scroll", sliceIndex: 10 }],
      },
      {
        t: 600,
        act: "search",
        say: "Follow the vessels into the mediastinum.",
        actions: [],
      },
    ],
  };
  const drivers = {
    applyEvent: () => {},
    getSliceIndex: () => 0,
    settle: async () => {},
  };
  const current = playTeachingGuide(previous, drivers, {
    timeScale: 0,
    narrate: (text) => {
      said.push(text);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(said, ["Follow the stack."]);
  interruptGuidePlayback(current, () => {
    stops.push("stop");
  });
  await current.finished;
  release();

  const notes = commitAnnotatedFinding(
    {
      label: "Notes orient prove #34",
      description: "Marker at the centre.",
      teachingPoints: ["Hold the level."],
      marker: { x_pct: 0.5, y_pct: 0.5, shape: "circle" },
      sliceIndex: 32,
    },
    { sliceIndex: 32 }
  ).finding.teachingGuide;
  assert.ok(notes);
  const next = playTeachingGuide(notes!, drivers, {
    timeScale: 0,
    narrate: async (text) => {
      said.push(text);
    },
  });
  await next.finished;
  assert.deepEqual(stops, ["stop"]);
  assert.equal(
    said.filter((line) => line === "Follow the stack.").length,
    1
  );
  assert.equal(
    said.some((line) => /vessels|mediastinum|lung window was hiding/i.test(line)),
    false
  );
  assert.match(said.join(" "), /Notes orient prove #34, on slice 33/);
  assert.doesNotMatch(said[said.length - 1] ?? "", /^Follow the stack/);
});

test("a notes guide lands the stored slice with the orient line and still speaks commit and pearl", async () => {
  // Live prove: caption said "Speak-once prove #37, on slice 39" while the
  // stack stayed on the opening frame (33/65). Storage is 0-based. Display
  // and the spoken number are that index plus one. The opening frame of a
  // 65-slice stack is index 32.
  const stored = 38;
  const opener = 32;
  const label = "Speak-once prove #37";
  const description = "Solid nodule at the right apex.";
  const pearl = "Compare it with the vessel";
  const track: RecordedTrack = {
    durationMs: 4000,
    start: { sliceIndex: opener, ww: 400, wc: 40 },
    events: [
      { t: 200, type: "slice", index: opener },
      { t: 800, type: "voi", ww: 1500, wc: -600 },
      { t: 1400, type: "camera", zoom: 2.2, pan: [0.1, 0] },
      { t: 2200, type: "slice", index: stored },
      { t: 3000, type: "cursor", x: 0.42, y: 0.58 },
    ],
  };
  const saved = commitSpeakOnceWithoutMic(
    {
      label,
      description,
      teachingPoints: [pearl],
      marker: { x_pct: 0.42, y_pct: 0.58, shape: "circle" },
    },
    track
  );
  const guide = resolveTeachingGuide(saved.finding);
  assert.ok(guide);
  assert.equal(guide.voice, "notes");
  assert.equal(displaySliceNumber(stored), stored + 1);
  const scroll = guide.beats
    .find((beat) => beat.act === "orient")
    ?.actions.find((action) => action.type === "scroll");
  assert.equal(scroll?.type, "scroll");
  if (scroll?.type === "scroll") assert.equal(scroll.sliceIndex, stored);
  const orientLine = `${label}, on slice ${displaySliceNumber(stored)}.`;
  assert.equal(guide.beats.find((beat) => beat.act === "orient")?.say, orientLine);
  assert.ok(guide.beats.some((beat) => beat.act === "search"));
  assert.equal(guide.beats.find((beat) => beat.act === "commit")?.say, description);
  assert.equal(guide.beats.find((beat) => beat.act === "pearl")?.say, `${pearl}.`);

  let slice = opener;
  const slicesAtSay: Array<{ text: string; slice: number }> = [];
  const windows: string[] = [];
  const points: string[] = [];
  let releaseOrient: () => void = () => {};
  const orientHung = new Promise<void>((resolve) => {
    releaseOrient = resolve;
  });
  const ctrl = playTeachingGuide(
    guide,
    {
      applyEvent: (event) => {
        if (event.type === "slice") slice = event.index;
      },
      getSliceIndex: () => {
        throw new Error("readout unavailable");
      },
      settle: async () => {},
      setWindow: async (ww, wc) => {
        windows.push(`${ww}/${wc}`);
      },
      showState: async (state) => {
        if (state.zoom != null) points.push(`zoom:${state.zoom}`);
      },
      overlay: {
        animateTo: async (x, y) => {
          points.push(`point:${x},${y}`);
        },
      },
    },
    {
      timeScale: 0,
      narrationHoldMs: () => 40,
      narrate: (text) => {
        slicesAtSay.push({ text, slice });
        if (text === orientLine) return orientHung;
        return Promise.resolve();
      },
    }
  );
  await ctrl.finished;
  releaseOrient();
  const orient = slicesAtSay.find((row) => row.text === orientLine);
  assert.ok(orient);
  assert.equal(orient.slice, stored);
  assert.equal(slice, stored);
  assert.deepEqual(
    slicesAtSay.map((row) => row.text),
    [
      orientLine,
      "Window 1500 over -600.",
      "Closer, about 2.2 times.",
      description,
      `${pearl}.`,
    ]
  );
  assert.ok(windows.includes("1500/-600"));
  assert.ok(points.includes("point:0.42,0.58"));
});

test("click-to-annotate notes also land the stored slice before the orient line is spoken", async () => {
  const stored = 40;
  const saved = commitAnnotatedFinding(
    {
      label: "Right chest wall opacity",
      description: "Pleural-based opacity along the right chest wall.",
      teachingPoints: ["Check the extrapleural fat."],
      marker: { x_pct: 0.82, y_pct: 0.4, shape: "circle" },
      sliceIndex: stored,
      windowWidth: 399,
      windowCenter: 45,
    },
    { sliceIndex: stored, windowWidth: 399, windowCenter: 45 }
  );
  const guide = resolveTeachingGuide(saved.finding);
  assert.equal(guide?.voice, "notes");
  const orientLine = `Right chest wall opacity, on slice ${displaySliceNumber(stored)}.`;
  let slice = 10;
  let sliceWhenSpoken = -1;
  const said: string[] = [];
  const ctrl = playTeachingGuide(
    guide!,
    {
      applyEvent: (event) => {
        if (event.type === "slice") slice = event.index;
      },
      getSliceIndex: () => slice,
      settle: async () => {},
      setWindow: async () => {},
      overlay: { animateTo: async () => {} },
    },
    {
      timeScale: 0,
      narrate: async (text) => {
        if (text === orientLine) sliceWhenSpoken = slice;
        said.push(text);
      },
    }
  );
  await ctrl.finished;
  assert.equal(sliceWhenSpoken, stored);
  assert.equal(slice, stored);
  assert.equal(said[0], orientLine);
  assert.equal(said.at(-2), "Pleural-based opacity along the right chest wall.");
  assert.equal(said.at(-1), "Check the extrapleural fat.");
});
