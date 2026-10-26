// ============================================================================
// lib/replay.ts  (client only)
//
// Two clocks share one viewer apply path:
//
//   • startReplay — exact re-application of a dense RecordedTrack. Author
//     Studio uses this to verify capture. Annotation strokes draw on the
//     overlay (ink animation). Slice / VOI / camera / invert / series go
//     through ReplayTarget.applyEvent.
//   • playTeachingGuide — the learner clock. A cleaned TeachingGuide
//     (scroll → window → zoom → point → draw → say) is performed with
//     applyEvent, eased VOI / camera when the driver provides them, and TTS
//     via `narrate`. This is not a playback of the teacher's microphone.
//
// THE DENSE CLOCK: if a narration <audio> element is provided we lock to its
// `currentTime`. With no audio we fall back to a wall clock (performance.now).
// ============================================================================

import type {
  RecordedEvent,
  RecordedTrack,
  TeachAct,
  TeachBeat,
  TeachViewerAction,
  TeachingGuide,
} from "./types";
import { narrationHoldMs } from "./tutorSpeech";
import {
  isNamingAct,
  moneySliceFromGuide,
  reseatBeat,
  studentIsFar,
} from "./tourAdapt";
import { decisionBeatIndex, type CheckInBranch } from "./tourCheckIn";

/** What an applier (the CornerstoneControls handle) must provide. */
export interface ReplayTarget {
  applyEvent: (e: RecordedEvent) => void;
  getStartState: () => { sliceIndex: number; ww?: number; wc?: number };
}

/** Overlay sink for the non-viewer events (laser pointer + annotation draw-in). */
export interface OverlaySink {
  cursor: (x: number, y: number, t: number) => void;
  annotation: (e: Extract<RecordedEvent, { type: "annotation" }>) => void;
  /** Called when replay finishes or is cancelled, to clear transient visuals. */
  clear: () => void;
}

export interface ReplayOptions {
  /** Narration audio to lock the clock to. Omit for a silent wall-clock replay. */
  audio?: HTMLAudioElement | null;
  overlay?: Partial<OverlaySink>;
  /** Fired with progress [0,1] each frame (drives a scrubber/progress bar). */
  onProgress?: (fraction: number, elapsedMs: number) => void;
  /** Fired once playback reaches the end (not on manual cancel). */
  onEnd?: () => void;
}

export interface ReplayController {
  /** Cancel the replay loop and clear overlay visuals. Idempotent. */
  cancel: () => void;
  /** True once cancelled or ended. */
  readonly done: boolean;
  /** Resolves when playback ends or is cancelled. */
  finished: Promise<void>;
}

/**
 * Prime the viewport to the track's start, then start the rAF loop. When an
 * audio element is supplied the caller is responsible for `audio.play()`
 * (so the browser keeps the user-gesture chain); we only READ currentTime.
 */
export function startReplay(
  track: RecordedTrack,
  target: ReplayTarget,
  opts: ReplayOptions = {}
): ReplayController {
  const events = track.events;
  const total = Math.max(1, track.durationMs);
  const overlay = opts.overlay;

  // Prime: snap to the recorded starting slice + window before the first event.
  target.applyEvent({ t: 0, type: "slice", index: track.start.sliceIndex });
  if (track.start.ww != null && track.start.wc != null) {
    target.applyEvent({ t: 0, type: "voi", ww: track.start.ww, wc: track.start.wc });
  }

  let cursorIdx = 0;
  let cancelled = false;
  let ended = false;
  let raf = 0;
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const wallStart = performance.now();

  const clockMs = (): number => {
    const a = opts.audio;
    if (a && !Number.isNaN(a.currentTime)) return a.currentTime * 1000;
    return performance.now() - wallStart;
  };

  const dispatch = (e: RecordedEvent) => {
    switch (e.type) {
      case "cursor":
        overlay?.cursor?.(e.x, e.y, e.t);
        break;
      case "annotation":
        overlay?.annotation?.(e);
        break;
      default:
        target.applyEvent(e);
    }
  };

  const finish = () => {
    if (ended || cancelled) return;
    ended = true;
    if (raf) cancelAnimationFrame(raf);
    opts.onProgress?.(1, total);
    overlay?.clear?.();
    opts.onEnd?.();
    resolveFinished();
  };

  const tick = () => {
    if (cancelled) return;
    const now = clockMs();

    // Fire every event whose time has arrived, in recorded order.
    while (cursorIdx < events.length && events[cursorIdx].t <= now) {
      dispatch(events[cursorIdx]);
      cursorIdx++;
    }

    opts.onProgress?.(Math.min(1, now / total), now);

    if (cursorIdx >= events.length && now >= total) {
      finish();
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);

  return {
    cancel() {
      if (cancelled || ended) return;
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      overlay?.clear?.();
      resolveFinished();
    },
    get done() {
      return cancelled || ended;
    },
    finished,
  };
}

/** What the learner guide drives. applyEvent is required; tweens are optional. */
export interface GuideDrivers {
  applyEvent: (e: RecordedEvent) => void;
  /** Current slice so a scroll can step instead of snapping the whole delta. */
  getSliceIndex?: () => number;
  /** Resolves when a programmatic slice / series switch has settled. */
  settle?: () => Promise<void>;
  /** Eased window/level. Falls back to a snapped voi applyEvent. */
  setWindow?: (ww: number, wc: number) => void | Promise<void>;
  /** Eased camera (zoom / pan). */
  showState?: (
    state: {
      sliceIndex?: number;
      zoom?: number;
      pan?: [number, number];
      windowWidth?: number;
      windowCenter?: number;
    },
    durationMs?: number
  ) => Promise<void> | void;
  /**
   * After applyEvent(annotation): false means the native tool did not land,
   * so the overlay should draw the stroke.
   */
  annotationLanded?: () => boolean;
  overlay?: Partial<OverlaySink> & {
    animateTo?: (
      x: number,
      y: number,
      opts?: { durationMs?: number }
    ) => Promise<void>;
  };
}

export interface GuidePlayOptions {
  /** Speak one beat. Omit for a silent visual pass (the tutor's own TTS). */
  narrate?: (text: string) => Promise<void>;
  /**
   * Prefetch the next say line while this beat is still speaking and driving.
   * Called after the current `narrate` has started (so it does not cancel the
   * clip in flight) and before that clip finishes. Must not start playback.
   */
  primeNarration?: (text: string) => void;
  /**
   * Fired once from `cancel`, before waits are released. Use it to stop
   * TTS when this guide owns the clip. A `speak()` that starts after
   * speech was stopped restarts the previous line.
   */
  onInterrupt?: () => void;
  onEnd?: () => void;
  /** Delay between stepped slices. Tests pass 0. */
  sliceStepMs?: number;
  /**
   * 1 follows the teacher's clock (holds included). 0 runs the gestures
   * back to back — unit tests. Speech is awaited until it ends or the
   * narration hold expires, whichever comes first.
   */
  timeScale?: number;
  /**
   * How long one say-line may block the next beat. Defaults to
   * narrationHoldMs on the learner clock, and to "wait for narrate" when
   * timeScale is 0 so unit tests stay synchronous. A returned promise that
   * never settles still loses to this hold.
   */
  narrationHoldMs?: (text: string) => number;
  /**
   * When the learner is far from the money slice at a commit or pearl,
   * scroll them there and say a directional line before that beat.
   * Default on. Following the script (already on the slice) inserts nothing.
   */
  adaptive?: boolean;
  /** Distance in slices that counts as far. Default 8. */
  farSlices?: number;
  /**
   * Pause before the decision beat (commit, or a beat marked `decision`)
   * and wait for a text check-in. Omit to play the script straight through.
   * `"paused"` stops the guide. `"skip"` or null plays the beat as authored.
   * A branch's preface runs first; its `skipActs` drop later beats (the pearl
   * after a correct answer). The callback must not move the viewer.
   */
  onCheckIn?: (
    ctx: { beat: TeachBeat; index: number }
  ) => Promise<CheckInBranch | "skip" | "paused" | null | void>;
  /** Anatomical level the hint may name, e.g. "carina". */
  landmark?: string;
  /** Terms the hint must not say — the finding label. */
  withholdTerms?: readonly string[];
}

/** A hung tween or slice settle must not freeze the rest of the script. */
const MOTION_CAP_MS = 4_000;

/**
 * Search / orient cine length. Intermediate frames use a short settle so a
 * cold DICOM decode cannot turn the walk into half a minute of dead air.
 * The last frame waits longer so lean-in zooms the money slice, not the one before it.
 */
export const SCROLL_WALK_MS = 1_600;
export const SCROLL_WALK_MAX_STEPS = 14;
const WALK_STEP_SETTLE_MS = 40;
const WALK_LAND_SETTLE_MS = 900;

/** Attending pause between beats. Longer teacher-clock gaps are pulled in to this. */
export const ATTENDING_HOLD_MIN_MS = 1_000;
export const ATTENDING_HOLD_MAX_MS = 3_000;

/**
 * How long to wait before a beat. A short scripted gap stays short. A long one
 * becomes at most {@link ATTENDING_HOLD_MAX_MS}, and time already spent finishing
 * the previous beat counts toward that hold.
 */
export function attendingGapMs(scriptedGapMs: number, elapsedMs: number): number {
  if (!Number.isFinite(scriptedGapMs) || scriptedGapMs <= 20) return 0;
  const wanted = Math.min(ATTENDING_HOLD_MAX_MS, Math.max(0, scriptedGapMs));
  const spent = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const remain = wanted - spent;
  return remain > 20 ? remain : 0;
}

/**
 * Slice indices to show while walking `from` → `to`. The last index is `to`.
 * Large deltas are sampled so the cine stays inside {@link SCROLL_WALK_MS};
 * a one-slice move is a single landing, not a fake intermediate.
 */
export function planSliceWalk(
  from: number,
  to: number,
  maxSteps: number = SCROLL_WALK_MAX_STEPS
): number[] {
  if (!Number.isFinite(to)) return [];
  const end = Math.round(to);
  if (!Number.isFinite(from)) return [end];
  const start = Math.round(from);
  if (start === end) return [end];
  const delta = end - start;
  const steps = Math.max(1, Math.min(Math.abs(delta), Math.max(1, maxSteps)));
  const out: number[] = [];
  let prev = start;
  for (let i = 1; i <= steps; i++) {
    const index = i === steps ? end : start + Math.trunc((delta * i) / steps);
    if (index === prev) continue;
    if (Math.abs(index - end) > Math.abs(prev - end)) continue;
    out.push(index);
    prev = index;
  }
  if (out.length === 0 || out[out.length - 1] !== end) out.push(end);
  return out;
}

type ScrollMode = "walk" | "land";

interface GuidePace {
  stepMs: number;
  scale: number;
  cancelled: () => boolean;
  wait: (ms: number) => Promise<void>;
  guard: (task: Promise<void> | void) => Promise<void>;
  cap: (task: Promise<void> | void, ms: number) => Promise<void>;
}

function readSliceIndex(drivers: GuideDrivers): number | undefined {
  try {
    return drivers.getSliceIndex?.();
  } catch {
    // A throwing readout must not cancel the rest of the script.
    return undefined;
  }
}

async function driveScroll(
  drivers: GuideDrivers,
  sliceIndex: number,
  seriesInstanceUID: string | undefined,
  pace: GuidePace,
  mode: ScrollMode
): Promise<void> {
  if (seriesInstanceUID) {
    drivers.applyEvent({ t: 0, type: "series", seriesInstanceUID });
    if (drivers.settle) await pace.guard(drivers.settle());
  }
  if (pace.cancelled()) return;
  // Land does not ask the viewport where it is. A notes orient names one
  // index; reading the stack must not throw away that scroll.
  if (mode === "land") {
    drivers.applyEvent({ t: 0, type: "slice", index: sliceIndex });
    if (drivers.settle) await pace.guard(drivers.settle());
    return;
  }
  const current = readSliceIndex(drivers);
  if (current == null || current === sliceIndex) {
    drivers.applyEvent({ t: 0, type: "slice", index: sliceIndex });
    if (drivers.settle) await pace.guard(drivers.settle());
    return;
  }
  const plan = planSliceWalk(current, sliceIndex);
  const gaps = Math.max(1, plan.length - 1);
  const stepWait = pace.scale <= 0 || pace.stepMs <= 0 ? 0 : Math.round(SCROLL_WALK_MS / gaps);
  const started = performance.now();
  for (let i = 0; i < plan.length; i++) {
    if (pace.cancelled()) return;
    const overdue =
      stepWait > 0 && performance.now() - started > SCROLL_WALK_MS + WALK_LAND_SETTLE_MS;
    const last = i === plan.length - 1 || overdue;
    const index = last ? sliceIndex : plan[i];
    drivers.applyEvent({ t: 0, type: "slice", index });
    if (drivers.settle) {
      await pace.cap(drivers.settle(), last ? WALK_LAND_SETTLE_MS : WALK_STEP_SETTLE_MS);
    }
    if (last) return;
    if (stepWait > 0) await pace.wait(stepWait);
  }
}

async function driveAction(
  action: TeachViewerAction,
  drivers: GuideDrivers,
  pace: GuidePace,
  scrollMode: ScrollMode
): Promise<void> {
  switch (action.type) {
    case "scroll":
      await driveScroll(
        drivers,
        action.sliceIndex,
        action.seriesInstanceUID,
        pace,
        scrollMode
      );
      return;
    case "window":
      if (drivers.setWindow) {
        await pace.guard(drivers.setWindow(action.ww, action.wc));
      } else {
        drivers.applyEvent({ t: 0, type: "voi", ww: action.ww, wc: action.wc });
      }
      return;
    case "zoom":
      if (drivers.showState) {
        const ms = pace.scale <= 0 ? 0 : 720;
        await pace.guard(drivers.showState({ zoom: action.zoom, pan: action.pan }, ms));
      } else {
        drivers.applyEvent({
          t: 0,
          type: "camera",
          zoom: action.zoom,
          pan: action.pan,
        });
      }
      return;
    case "invert":
      drivers.applyEvent({ t: 0, type: "invert", value: action.value });
      return;
    case "point":
      if (drivers.overlay?.animateTo) {
        const ms = pace.scale <= 0 ? 0 : 700;
        await pace.guard(drivers.overlay.animateTo(action.x, action.y, { durationMs: ms }));
      } else {
        drivers.overlay?.cursor?.(action.x, action.y, 0);
      }
      return;
    case "pause":
      return;
    case "annotate": {
      if (action.sliceIndex != null) {
        await driveScroll(drivers, action.sliceIndex, undefined, pace, "land");
        if (pace.cancelled()) return;
      }
      const { type: _type, ...stroke } = action;
      const event: RecordedEvent = { t: 0, type: "annotation", ...stroke };
      drivers.applyEvent(event);
      if (drivers.settle) await pace.guard(drivers.settle());
      if (drivers.annotationLanded && !drivers.annotationLanded()) {
        drivers.overlay?.annotation?.(event);
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Abort the guide on screen and stop its speech before another finding's
 * guide starts. Cancel runs first. A beat that calls `speak()` after speech
 * was stopped restarts the previous line — the demo "Follow the stack." —
 * over the finding that is now active.
 */
export function interruptGuidePlayback(
  current: ReplayController | null | undefined,
  stopSpeech: () => void
): void {
  current?.cancel();
  stopSpeech();
}

/**
 * Perform a cleaned teach script. Primes the recorded slice and window, then
 * runs each beat's viewer actions while that beat's line is spoken. The next
 * say line is handed to `primeNarration` after this line's speech starts, so
 * its TTS fetch overlaps the clip and the gestures. The following beat does
 * not start until this beat's motion finishes. A look-cue
 * orient defers its scroll to the search line so the stack walks with that
 * sentence. A notes orient names one slice, so that scroll lands with the
 * orient line (stored index; the sentence says index + 1). Lean-in, commit,
 * and pearl land on the exact index. A long scripted gap is an attending hold
 * (at most a few seconds). A pause holds the image. Hung speech loses to the
 * narration hold so Speaking cannot latch forever. A gesture that throws does
 * not drop the beats after it.
 */
export function playTeachingGuide(
  guide: TeachingGuide,
  drivers: GuideDrivers,
  opts: GuidePlayOptions = {}
): ReplayController {
  let cancelled = false;
  let ended = false;
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const scale = opts.timeScale ?? 1;
  const stepMs = scale <= 0 ? 0 : (opts.sliceStepMs ?? 36);
  const origin = performance.now();
  const stops = new Set<() => void>();

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (ms <= 0 || cancelled) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        stops.delete(stop);
        resolve();
      }, ms);
      const stop = () => {
        clearTimeout(timer);
        stops.delete(stop);
        resolve();
      };
      stops.add(stop);
    });

  // Resolves when `task` settles or the cap hits. The cap timer is cleared
  // so a fast tween does not leave a dangling timeout.
  const raceCap = (task: Promise<void>, ms: number) =>
    new Promise<void>((resolve) => {
      if (ms <= 0 || cancelled) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stops.delete(stop);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      const stop = () => finish();
      stops.add(stop);
      task.then(finish, finish);
    });

  const settleWork = (task: Promise<void> | void): Promise<void> =>
    Promise.resolve(task).then(
      () => undefined,
      () => undefined
    );

  const guard = (task: Promise<void> | void): Promise<void> => {
    const work = settleWork(task);
    if (scale <= 0) return work;
    return raceCap(work, MOTION_CAP_MS);
  };

  const cap = (task: Promise<void> | void, ms: number): Promise<void> => {
    const work = settleWork(task);
    if (ms <= 0) return work;
    return raceCap(work, ms);
  };

  // Hold bounds how long a line may block the next beat. Cancel always
  // releases the wait, including a timeScale of 0 (hold 0), which otherwise
  // sits on the narrate promise until the clip ends.
  const awaitSpeech = (task: Promise<void>, holdMs: number) =>
    new Promise<void>((resolve) => {
      if (cancelled) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        stops.delete(stop);
        resolve();
      };
      const stop = () => finish();
      stops.add(stop);
      const timer = holdMs > 0 ? setTimeout(finish, holdMs) : 0;
      task.then(finish, finish);
    });

  const pace: GuidePace = {
    stepMs,
    scale,
    cancelled: () => cancelled,
    wait,
    guard,
    cap,
  };

  const holdFor = (text: string) => {
    if (opts.narrationHoldMs) return Math.max(0, opts.narrationHoldMs(text));
    if (scale <= 0) return 0;
    return narrationHoldMs(text);
  };

  const close = (callEnd: boolean) => {
    if (ended) return;
    ended = true;
    for (const stop of [...stops]) stop();
    if (callEnd && !cancelled) opts.onEnd?.();
    resolveFinished();
  };

  void (async () => {
    try {
      // A scripted scroll is walked later (search, or orient when there is no
      // search beat). Snapping to the approach slice here is the teleport.
      const walksIn = guide.beats.some(
        (beat) =>
          beat.act !== "lean-in" &&
          beat.act !== "commit" &&
          beat.act !== "pearl" &&
          beat.actions.some((action) => action.type === "scroll")
      );
      if (!walksIn) {
        drivers.applyEvent({
          t: 0,
          type: "slice",
          index: guide.start.sliceIndex,
        });
        if (drivers.settle) await guard(drivers.settle());
      }
      if (
        !cancelled &&
        guide.start.ww != null &&
        guide.start.wc != null &&
        Number.isFinite(guide.start.ww) &&
        Number.isFinite(guide.start.wc)
      ) {
        if (drivers.setWindow) await guard(drivers.setWindow(guide.start.ww, guide.start.wc));
        else {
          drivers.applyEvent({
            t: 0,
            type: "voi",
            ww: guide.start.ww,
            wc: guide.start.wc,
          });
        }
      }

      // A later finding inherits the previous lean-in. Snap back to fit so
      // this script's zoom beat is a visible lean-in, not a no-op at 2.2×.
      if (
        !cancelled &&
        drivers.showState &&
        guide.beats.some((beat) => beat.actions.some((action) => action.type === "zoom"))
      ) {
        await guard(drivers.showState({ zoom: 1, pan: [0, 0] }, 0));
      }

      const guideHasSearch = guide.beats.some((beat) => beat.act === "search");
      // Notes orient says "on slice N". Deferring that scroll until search
      // leaves the stack on the opening slice for the whole sentence.
      const deferOrientScroll = guideHasSearch && guide.voice !== "notes";
      let pendingWalk: Extract<TeachViewerAction, { type: "scroll" }> | null = null;
      let prevT = 0;
      let prevEnded = origin;

      const performBeat = async (beat: TeachBeat, primeNext: string) => {
        if (cancelled) return;
        if (scale > 0) {
          const gap = attendingGapMs(beat.t - prevT, performance.now() - prevEnded);
          if (gap > 20) {
            await wait(gap);
            if (cancelled) return;
          }
        }
        const motion = (async () => {
          try {
            // The search line names the window ("Lung windows, 1500 over
            // -600") while the orient scroll is still walking. Set that
            // window before the walk so the sentence and the viewport match.
            // The action below runs it again after the landing slice — a
            // slice load reloads the DICOM window unless the viewer pins it.
            if (beat.act === "search" && pendingWalk) {
              for (const action of beat.actions) {
                if (cancelled) return;
                if (action.type !== "window") continue;
                await driveAction(action, drivers, pace, "walk");
              }
            }
            if (beat.act === "search" && pendingWalk) {
              const pending = pendingWalk;
              pendingWalk = null;
              await driveScroll(
                drivers,
                pending.sliceIndex,
                pending.seriesInstanceUID,
                pace,
                "walk"
              );
              if (cancelled) return;
            }
            for (const action of beat.actions) {
              if (cancelled) return;
              if (action.type === "pause") {
                if (scale > 0 && action.ms > 0) {
                  const ms = Math.min(action.ms, ATTENDING_HOLD_MAX_MS);
                  if (ms > 20) await wait(ms);
                }
                continue;
              }
              // Look-cue money scroll is authored on orient. Walk it with the
              // search line so the stack moves while the window is set.
              // A notes orient names the slice, so it lands here instead.
              if (action.type === "scroll" && beat.act === "orient" && guide.voice === "notes") {
                await driveAction(action, drivers, pace, "land");
                continue;
              }
              if (action.type === "scroll" && beat.act === "orient" && deferOrientScroll) {
                pendingWalk = action;
                continue;
              }
              const scrollMode: ScrollMode =
                beat.act === "lean-in" || beat.act === "commit" || beat.act === "pearl"
                  ? "land"
                  : "walk";
              await driveAction(action, drivers, pace, scrollMode);
            }
          } catch {
            // A failed scroll or window must not swallow commit and pearl.
          }
        })();
        const line = beat.say?.trim() ?? "";
        // A blank line must not call narrate. A rejected or hung TTS call
        // must not skip the rest of the script or leave Speaking latched.
        // Cancel resolves this wait even when the hold is 0, so a later beat
        // cannot start after the finding has changed. The in-flight narrate
        // promise may still settle; onInterrupt stops its audio.
        //
        // Motion is already running (the async IIFE above). narrate is
        // started in the same turn, so scroll / window / zoom / point are
        // not gated on the clip ending. primeNarration runs after narrate
        // has entered its TTS call: the next line's fetch overlaps this
        // clip and this beat's gestures. The next beat still waits until
        // this beat's motion finishes, so two scrolls cannot race.
        const speechWork =
          line && opts.narrate && !cancelled
            ? opts.narrate(line).then(
                () => undefined,
                () => undefined
              )
            : Promise.resolve();
        if (!cancelled && primeNext) opts.primeNarration?.(primeNext);
        const hold = line ? holdFor(line) : 0;
        const speech = awaitSpeech(speechWork, hold);
        await Promise.all([motion, speech]);
        prevT = beat.t;
        prevEnded = performance.now();
      };

      const money = moneySliceFromGuide(guide);
      const decisionAt = opts.onCheckIn ? (decisionBeatIndex(guide) ?? -1) : -1;
      const skip = new Set<TeachAct>();

      const sayAfter = (index: number) => {
        for (let j = index + 1; j < guide.beats.length; j++) {
          const later = guide.beats[j];
          if (later?.act && skip.has(later.act)) continue;
          const line = later?.say?.trim() ?? "";
          if (line) return line;
        }
        return "";
      };

      // Cancel resolves this even when the student never picks. The callback
      // must not be required to settle — Pause and Space both cancel the guide.
      const awaitDecision = (beat: TeachBeat, index: number) =>
        new Promise<CheckInBranch | "skip" | "paused" | null>((resolve) => {
          let settled = false;
          const finish = (value: CheckInBranch | "skip" | "paused" | null) => {
            if (settled) return;
            settled = true;
            stops.delete(stop);
            resolve(value);
          };
          const stop = () => finish("paused");
          stops.add(stop);
          if (!opts.onCheckIn) {
            finish("skip");
            return;
          }
          Promise.resolve()
            .then(() => opts.onCheckIn?.({ beat, index }))
            .then(
              (value) => finish(value && typeof value === "object" ? value : value === "paused" ? "paused" : "skip"),
              () => finish("skip")
            );
        });

      for (let i = 0; i < guide.beats.length; i++) {
        const beat = guide.beats[i];
        if (!beat || cancelled) break;
        if (i !== decisionAt && beat.act && skip.has(beat.act)) continue;
        // Orient is the scroll onto the money slice. A hint before it would
        // double the linear path. Commit points and pearl names — those wait
        // until the learner is actually on the slice.
        try {
          if (opts.adaptive !== false && isNamingAct(beat.act) && money) {
            const here = readSliceIndex(drivers);
            if (
              here != null &&
              studentIsFar(here, money.sliceIndex, opts.farSlices)
            ) {
              // The hint is unprimed. Do not pass the scripted next line
              // here: the hint's narrate would still be the current speech,
              // and priming the beat after this one would replace the fetch
              // already started for `beat` itself.
              await performBeat(
                reseatBeat({
                  currentSlice: here,
                  targetSlice: money.sliceIndex,
                  t: beat.t,
                  landmark: opts.landmark,
                  withhold: opts.withholdTerms,
                  seriesInstanceUID: money.seriesInstanceUID,
                }),
                ""
              );
              if (cancelled) break;
            }
          }
          if (i === decisionAt) {
            const resolution = await awaitDecision(beat, i);
            if (cancelled || resolution === "paused") break;
            if (resolution && typeof resolution === "object") {
              for (const extra of resolution.preface) {
                if (cancelled) break;
                await performBeat(extra, "");
              }
              if (cancelled) break;
              for (const act of resolution.skipActs) skip.add(act);
            }
          }
          if (cancelled) break;
          await performBeat(beat, sayAfter(i));
        } catch {
          if (cancelled) break;
        }
      }
    } finally {
      close(true);
    }
  })();

  return {
    cancel() {
      if (cancelled || ended) return;
      cancelled = true;
      // Stop speech before releasing waits. A resumed beat that calls
      // speak() after stopSpeaking restarts the line that was just cut.
      opts.onInterrupt?.();
      for (const stop of [...stops]) stop();
    },
    get done() {
      return cancelled || ended;
    },
    finished,
  };
}
