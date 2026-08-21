// ============================================================================
// lib/replay.ts  (client only — Author Studio QA)
//
// Exact re-application of a RecordedTrack for the TEACHER to verify capture.
// The student product does NOT VCR-replay tracks; digests arm the AI tutor
// instead (docs/CONSULTANT_READING.md).
//
// THE CLOCK: if a narration <audio> element is provided we lock to its
// `currentTime`. With no audio we fall back to a wall clock (performance.now).
// ============================================================================

import type { RecordedEvent, RecordedTrack } from "./types";

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
    },
    get done() {
      return cancelled || ended;
    },
  };
}
