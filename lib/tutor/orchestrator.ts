import { matchesView } from '../journal/match';
import type { RenderConfirmedViewer } from '../viewerController';
import type { ViewerSnapshot } from '../journal/types';
import { TutorCommandError, type TutorCommand, type TutorStep } from './commands';
export type TutorBeat = { text: string; actions: TutorCommand[] };
export type TutorPhase = 'idle' | 'resolving' | 'rendering' | 'speaking' | 'cancelled' | 'failed';
export interface TutorDependencies {
  viewer(): Partial<RenderConfirmedViewer> | null;
  resolve(command: TutorCommand, findingId: string | undefined, view: ViewerSnapshot | undefined, signal: AbortSignal): Promise<TutorStep>;
  speak(text: string, signal: AbortSignal): Promise<void>;
  stopSpeech(): void;
  onStep?(step: TutorStep): void;
  onState?(phase: TutorPhase, message?: string): void;
  timeoutMs?: number;
  speechTimeoutMs?: number;
}
const cancelled = () => new DOMException('Tutor interrupted', 'AbortError');
function cancellable<T>(promise: Promise<T>, signal: AbortSignal, timeout?: number, timeoutMessage = 'The tutor image did not render in time. No speech was released.'): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => finish(undefined, cancelled());
    function finish(value?: T, error?: unknown) { clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value as T); }
    if (signal.aborted) return reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    if (timeout !== undefined) timer = setTimeout(() => finish(undefined, new TutorCommandError(timeoutMessage)), timeout);
    promise.then(value => finish(value), error => finish(undefined, error));
  });
}
/** One generation owns authorization, every render acknowledgement and speech. */
export class TutorOrchestrator {
  private generation = 0;
  private abort: AbortController | null = null;
  private phase: TutorPhase = 'idle';
  private expected: ViewerSnapshot | null = null;
  private offRender?: () => void;
  constructor(private deps: TutorDependencies) {}
  interrupt(message = 'Tutor paused.') {
    this.generation++; this.abort?.abort(); this.abort = null;
    this.offRender?.(); this.offRender = undefined;
    this.deps.viewer()?.cancelView?.(); this.deps.stopSpeech(); this.expected = null;
    this.phase = 'cancelled'; this.deps.onState?.('cancelled', message);
  }
  get currentGeneration() { return this.generation; }
  async run(beats: TutorBeat[], currentFindingId?: string): Promise<'completed' | 'cancelled' | 'failed'> {
    this.interrupt();
    const generation = this.generation, abort = new AbortController(); this.abort = abort;
    const signal = abort.signal, viewer = this.deps.viewer(); let index = 0, current = currentFindingId;
    const check = () => { if (signal.aborted || generation !== this.generation) throw cancelled(); };
    const state = (p: TutorPhase, message?: string) => { check(); this.phase = p; this.deps.onState?.(p, message); };
    const rendered = () => viewer?.getRenderedView?.()?.snapshot;
    this.offRender = viewer?.onRendered?.(view => {
      if (this.phase === 'speaking' && this.expected && !matchesView(view.snapshot, this.expected)) this.interrupt('The view changed. Tutor paused.');
    });
    try {
      if (!viewer?.requestView || !viewer.getRenderedView) throw new TutorCommandError('A render-confirmed viewer is required.');
      for (const beat of beats) {
        let last: TutorStep | undefined;
        for (const command of beat.actions.length ? beat.actions : [{ type: 'hold' } as const]) {
          state('resolving', 'Checking the current approved image…');
          const step = await cancellable(this.deps.resolve(command, current, rendered(), signal), signal); check();
          const shown = rendered();
          if (!shown || /mpr|volume/i.test(shown.layout)) throw new TutorCommandError('Use the primary stack viewport for tutor commands.');
          // Bind the approved image/view to this primary renderer instance, not an author viewport's ID.
          const snapshot = { ...step.snapshot, viewportId: shown.viewportId, layout: shown.layout };
          const commandId = `tutor-${generation}-${++index}`;
          state('rendering', 'Waiting for the approved image to render…');
          const ack = await cancellable(viewer.requestView({ commandId, generation, snapshot, timeoutMs: this.deps.timeoutMs ?? 5000 }), signal, this.deps.timeoutMs ?? 5000); check();
          if (ack.commandId !== commandId || ack.generation !== generation || !matchesView(ack.snapshot, snapshot)) throw new TutorCommandError('The renderer confirmed a different tutor image. No speech was released.');
          this.expected = snapshot;
          if (step.shapes) {
            if (!viewer.showReplayGeometry) throw new TutorCommandError('Approved image geometry cannot be displayed.');
            viewer.showReplayGeometry(step.shapes);
          }
          current = step.findingId; last = step; this.deps.onStep?.(step);
        }
        if (beat.text.trim()) {
          // Approval may change while rendering. Revalidate the pinned ID, without moving the viewer again.
          if (!last) throw new TutorCommandError();
          const checked = await cancellable(this.deps.resolve({ type: 'show_anchor', anchorId: last.anchorId }, current, undefined, signal), signal); check();
          if (checked.anchorId !== last.anchorId || !this.expected || !rendered() || !matchesView(rendered()!, this.expected)) throw new TutorCommandError('Tutor evidence changed before speech. Retry the question.');
          state('speaking');
          await cancellable(this.deps.speak(beat.text, signal), signal, this.deps.speechTimeoutMs ?? 30000, 'Tutor audio did not finish in time. Playback stopped.'); check();
        }
      }
      state('idle'); return 'completed';
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return 'cancelled';
      abort.abort();
      viewer?.cancelView?.(); this.deps.stopSpeech();
      this.phase = 'failed'; this.deps.onState?.('failed', error instanceof Error ? error.message : 'Tutor stopped before speech.'); return 'failed';
    } finally {
      if (generation === this.generation) { this.offRender?.(); this.offRender = undefined; this.abort = null; }
    }
  }
}
