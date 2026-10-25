import { test } from "node:test";
import assert from "node:assert/strict";
import { playTeachingGuide, startReplay } from "./replay.ts";
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
