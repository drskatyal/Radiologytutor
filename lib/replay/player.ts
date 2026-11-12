import { matchesView } from "../journal/match";
import type { RenderConfirmedViewer } from "../viewerController";
import type { JournalEntry, ViewerSnapshot } from "../journal/types";
import { replayShape } from "./geometry";
import { ReplayError, type ReplayPlan, type ReplayResult, type ReplayShape, type ReplayState } from "./types";
export interface ReplayAudio {
  /** The same monotonic clock used to schedule decoded audio. */
  now(): number;
  schedule(fromMs: number, untilMs: number, audio: NonNullable<ReplayPlan["audio"]>): void;
  pause(): void;
}
export interface ReplayViewer extends Pick<RenderConfirmedViewer, "requestView"> {
  onRendered?: RenderConfirmedViewer["onRendered"];
  cancelView?: () => void;
  showReplayGeometry?: (shapes: ReplayShape[]) => void;
}
export interface PlayerOptions {
  audio?: ReplayAudio; now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  onState?: (state: ReplayState) => void;
  onConfirmed?: (confirmation: ReplayResult["confirmations"][number]) => void;
}
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new ReplayError("cancelled", "Replay stopped.")); return; }
  const abort = () => { clearTimeout(timer); reject(new ReplayError("cancelled", "Replay stopped.")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  signal.addEventListener("abort", abort, { once: true });
});
let nextGeneration = 0;
/** One clock. Rendering freezes timeline AND audio; a miss never advances to the next image. */
export function playJournal(plan: ReplayPlan, viewer: ReplayViewer, options: PlayerOptions = {}) {
  const abort = new AbortController(), generation = ++nextGeneration;
  const now = options.now ?? (() => options.audio?.now() ?? performance.now());
  const wait = options.sleep ?? sleep, shapes = new Map<string, ReplayShape>();
  const result: ReplayResult = { outcome: "completed", confirmations: [], misses: [] };
  let elapsed = 0, base = 0, started = now(), boundary = 0, running = false, done = false, index = -1;
  const interruption: { error: ReplayError | null } = { error: null };
  let expected: ViewerSnapshot | null = null;
  const offRender = viewer.onRendered?.(view => {
    if (running && expected && !matchesView(view.snapshot, expected)) {
      interruption.error = new ReplayError("view_changed", "The view changed during replay. Replay stopped; retry to restore the recorded view.");
      abort.abort();
    }
  });
  let state: ReplayState = { phase: "waiting", elapsedMs: 0, seq: null, message: "Waiting for the first recorded image…" };
  const position = () => running ? Math.min(boundary, base + Math.max(0, now() - started)) : elapsed;
  const safePosition = () => { try { return position(); } catch { return elapsed; } };
  const publish = (phase: ReplayState["phase"], message = "") => {
    state = { phase, elapsedMs: position(), seq: plan.journal[index]?.seq ?? null, message };
    options.onState?.({ ...state });
  };
  const freeze = (t: number) => { elapsed = t; running = false; options.audio?.pause(); };
  const resume = (t: number) => {
    base = t; elapsed = t; started = now(); running = true;
    boundary = plan.journal.slice(index + 1).find(e => e.kind === "render" || e.kind === "layout")?.t ?? plan.durationMs;
    if (plan.audio) {
      if (!options.audio) throw new ReplayError("audio_unavailable", "Recorded audio could not be loaded.");
      // Audio is scheduled to STOP at the next image boundary even if the UI thread stalls.
      options.audio.schedule(t, boundary, plan.audio);
    }
    publish("playing", "Replaying confirmed images and recorded audio.");
  };
  const confirm = async (snapshot: ViewerSnapshot, seq: number | null, t: number) => {
    freeze(t); publish("waiting", "Waiting for the recorded image to render…");
    const commandId = `replay-${generation}-${seq ?? "initial"}`, before = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const ack = await Promise.race([
        viewer.requestView({ commandId, generation, snapshot, timeoutMs: options.timeoutMs ?? 5000 }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ReplayError("timeout", "The recorded image did not render in time. Replay stopped.", seq)), options.timeoutMs ?? 5000);
          onAbort = () => reject(new ReplayError("cancelled", "Replay stopped.", seq));
          abort.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (abort.signal.aborted) throw new ReplayError("cancelled", "Replay stopped.", seq);
      if (ack.commandId !== commandId || ack.generation !== generation || !matchesView(ack.snapshot, snapshot)) throw new ReplayError("mismatched_ack", "The renderer confirmed a different image or view. Replay stopped.", seq);
      const confirmation = { seq, t, snapshot: ack.snapshot, waitMs: Math.max(0, now() - before) };
      expected = snapshot;
      result.confirmations.push(confirmation); options.onConfirmed?.(confirmation);
      viewer.showReplayGeometry?.([...shapes.values()]);
    } finally { clearTimeout(timer); if (onAbort) abort.signal.removeEventListener("abort", onAbort); }
  };
  const finished = (async (): Promise<ReplayResult> => {
    try {
      // Prime a complete recorded snapshot; never a legacy index or the browser's opening offset.
      await confirm(plan.initial, null, 0); resume(0);
      for (index = 0; index < plan.journal.length; index++) {
        const entry: JournalEntry = plan.journal[index];
        while (position() < entry.t) {
          if (abort.signal.aborted) throw new ReplayError("cancelled", "Replay stopped.");
          publish("playing"); await wait(Math.min(16, entry.t - position()), abort.signal);
        }
        if (abort.signal.aborted) throw new ReplayError("cancelled", "Replay stopped.");
        if (entry.kind === "render" || entry.kind === "layout") { await confirm(entry.snapshot!, entry.seq, entry.t); resume(entry.t); }
        else if (entry.kind === "marker" || entry.kind === "annotation") {
          const shape = replayShape(entry, plan.journal.slice(0, index + 1));
          if (shape) shapes.set(shape.id, shape); else shapes.delete(String(entry.payload?.markerId ?? entry.payload?.annotationId));
          if (!viewer.showReplayGeometry) throw new ReplayError("geometry", "This viewer cannot restore recorded annotations.", entry.seq);
          viewer.showReplayGeometry([...shapes.values()]);
        }
        // Inputs are intent, not confirmed state. Measurement entries duplicate their annotation.
      }
      while (position() < plan.durationMs) { publish("playing"); await wait(Math.min(16, plan.durationMs - position()), abort.signal); }
      freeze(plan.durationMs); publish("completed", "Exact replay complete.");
    } catch (error) {
      freeze(safePosition()); viewer.cancelView?.(); try { viewer.showReplayGeometry?.([]); } catch { /* preserve the original miss */ }
      const code = interruption.error?.code ?? (abort.signal.aborted ? "cancelled" : (error as { code?: string }).code ?? "replay_failed");
      result.outcome = code === "cancelled" ? "cancelled" : "failed";
      const message = interruption.error?.message ?? (code === "missing_identity" ? "Image not found: rebind. Replay stopped." : error instanceof Error ? error.message : "Replay failed. No image was substituted.");
      result.misses.push({ seq: plan.journal[index]?.seq ?? null, t: elapsed, code, message });
      publish(result.outcome, message);
    } finally { offRender?.(); done = true; options.audio?.pause(); }
    return result;
  })();
  return { finished, cancel: () => { if (!done) { freeze(safePosition()); abort.abort(); viewer.cancelView?.(); } }, get done() { return done; }, get state() { return { ...state, elapsedMs: position() }; } };
}
