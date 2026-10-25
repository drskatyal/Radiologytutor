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
  /** Anatomical level the hint may name, e.g. "carina". */
  landmark?: string;
  /** Terms the hint must not say — the finding label. */
  withholdTerms?: readonly string[];
}

/** A hung tween or slice settle must not freeze the rest of the script. */
const MOTION_CAP_MS = 4_000;

interface GuidePace {
  stepMs: number;
  scale: number;
  cancelled: () => boolean;
  wait: (ms: number) => Promise<void>;
  guard: (task: Promise<void> | void) => Promise<void>;
}

async function driveScroll(
  drivers: GuideDrivers,
  sliceIndex: number,
  seriesInstanceUID: string | undefined,
  pace: GuidePace
): Promise<void> {
  if (seriesInstanceUID) {
    drivers.applyEvent({ t: 0, type: "series", seriesInstanceUID });
    if (drivers.settle) await pace.guard(drivers.settle());
  }
  if (pace.cancelled()) return;
  const current = drivers.getSliceIndex?.();
  if (current == null || current === sliceIndex) {
    drivers.applyEvent({ t: 0, type: "slice", index: sliceIndex });
    if (drivers.settle) await pace.guard(drivers.settle());
    return;
  }
  let pos = current;
  while (pos !== sliceIndex) {
    if (pace.cancelled()) return;
    const remaining = sliceIndex - pos;
    const mag = Math.abs(remaining);
    const hop = mag > 28 ? Math.sign(remaining) * Math.ceil(mag / 28) : Math.sign(remaining);
    pos = mag <= Math.abs(hop) ? sliceIndex : pos + hop;
    drivers.applyEvent({ t: 0, type: "slice", index: pos });
    if (drivers.settle) await pace.guard(drivers.settle());
    if (pace.stepMs > 0 && pos !== sliceIndex) await pace.wait(pace.stepMs);
  }
}

async function driveAction(
  action: TeachViewerAction,
  drivers: GuideDrivers,
  pace: GuidePace
): Promise<void> {
  switch (action.type) {
    case "scroll":
      await driveScroll(drivers, action.sliceIndex, action.seriesInstanceUID, pace);
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
        await driveScroll(drivers, action.sliceIndex, undefined, pace);
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
 * Perform a cleaned teach script on the teacher's clock. Primes the recorded
 * start slice and window, waits until each beat's timestamp, then runs that
 * beat's viewer actions while the line for that beat is spoken. Scroll steps
 * through intermediate slices; window and zoom ease; a pause holds the image.
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

  const guard = (task: Promise<void> | void): Promise<void> => {
    const work = Promise.resolve(task).then(
      () => undefined,
      () => undefined
    );
    if (scale <= 0) return work;
    return raceCap(work, MOTION_CAP_MS);
  };

  const pace: GuidePace = {
    stepMs,
    scale,
    cancelled: () => cancelled,
    wait,
    guard,
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
      drivers.applyEvent({
        t: 0,
        type: "slice",
        index: guide.start.sliceIndex,
      });
      if (drivers.settle) await guard(drivers.settle());
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

      const performBeat = async (beat: TeachBeat) => {
        if (cancelled) return;
        if (scale > 0) {
          const due = origin + beat.t * scale - performance.now();
          if (due > 20) {
            await wait(due);
            if (cancelled) return;
          }
        }
        const motion = (async () => {
          for (const action of beat.actions) {
            if (cancelled) return;
            if (action.type === "pause") {
              if (scale > 0 && action.ms > 0) {
                const target = origin + (beat.t + action.ms) * scale;
                const remain = target - performance.now();
                if (remain > 20) await wait(remain);
              }
              continue;
            }
            await driveAction(action, drivers, pace);
          }
        })();
        const line = beat.say?.trim() ?? "";
        // A blank line must not call narrate. A rejected or hung TTS call
        // must not skip the rest of the script or leave Speaking latched.
        const speechWork =
          line && opts.narrate
            ? opts.narrate(line).then(
                () => undefined,
                () => undefined
              )
            : Promise.resolve();
        const hold = line ? holdFor(line) : 0;
        const speech = hold > 0 ? raceCap(speechWork, hold) : speechWork;
        await Promise.all([motion, speech]);
      };

      const money = moneySliceFromGuide(guide);
      for (const beat of guide.beats) {
        if (cancelled) break;
        // Orient is the scroll onto the money slice. A hint before it would
        // double the linear path. Commit points and pearl names — those wait
        // until the learner is actually on the slice.
        if (opts.adaptive !== false && isNamingAct(beat.act) && money) {
          const here = drivers.getSliceIndex?.();
          if (
            here != null &&
            studentIsFar(here, money.sliceIndex, opts.farSlices)
          ) {
            await performBeat(
              reseatBeat({
                currentSlice: here,
                targetSlice: money.sliceIndex,
                t: beat.t,
                landmark: opts.landmark,
                withhold: opts.withholdTerms,
                seriesInstanceUID: money.seriesInstanceUID,
              })
            );
            if (cancelled) break;
          }
        }
        await performBeat(beat);
      }
    } finally {
      close(true);
    }
  })();

  return {
    cancel() {
      if (cancelled || ended) return;
      cancelled = true;
      for (const stop of [...stops]) stop();
    },
    get done() {
      return cancelled || ended;
    },
    finished,
  };
}
