import { test } from "node:test";
import assert from "node:assert/strict";
import { startReplay } from "./replay.ts";
import type { RecordedEvent, RecordedTrack } from "./types.ts";

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
