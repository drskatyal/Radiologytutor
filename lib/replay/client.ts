import type { RecordedTrack } from '../types';
import { replayPlan } from './plan';
import { ReplayBufferAudio } from './audio';
import { playJournal, type PlayerOptions, type ReplayViewer } from './player';
import { ReplayError, type ReplayResult } from './types';
/** Call during a user gesture: unlock Web Audio before loading retained media. */
export function startExactReplay(load: (signal: AbortSignal) => Promise<{ track: RecordedTrack; audioUrl: string | null }>, viewer: ReplayViewer, options: PlayerOptions = {}) {
  const abort = new AbortController(); let player: ReturnType<typeof playJournal> | undefined, audio: ReplayBufferAudio | undefined;
  let done = false;
  try { audio = new ReplayBufferAudio(); } catch { /* silent takes work without Web Audio */ }
  const unlock = audio?.unlock().then(() => null, () => new ReplayError('audio_blocked', 'Allow audio playback, then retry replay.'));
  options.onState?.({ phase: 'loading', elapsedMs: 0, seq: null, message: 'Loading the retained take…' });
  const hidden = () => { if (document.hidden) { abort.abort(); player?.cancel(); audio?.pause(); } };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', hidden);
  const finished = (async (): Promise<ReplayResult> => {
    try {
      viewer.showReplayGeometry?.([]);
      const source = await load(abort.signal);
      if (abort.signal.aborted) throw new ReplayError('cancelled', 'Replay stopped.');
      const hasAudio = !!source.audioUrl || !!source.track.mediaManifest?.chunks.some(c => c.stream === 'audio');
      const plan = replayPlan(source.track, hasAudio);
      if (hasAudio) {
        const error = await unlock; if (error) throw error;
        if (!audio || !source.audioUrl) throw new ReplayError('audio_unavailable', 'Recorded audio could not be loaded.');
        const response = await fetch(source.audioUrl, { signal: abort.signal, cache: 'no-store' });
        if (!response.ok) throw new ReplayError('audio_unavailable', 'Recorded audio could not be loaded.');
        await audio.load(await response.arrayBuffer());
      }
      if (abort.signal.aborted) throw new ReplayError('cancelled', 'Replay stopped.');
      player = playJournal(plan, viewer, { ...options, audio: hasAudio ? audio : undefined });
      return await player.finished;
    } catch (error) {
      const code = abort.signal.aborted ? 'cancelled' : (error as { code?: string }).code ?? 'replay_failed';
      const message = code === 'cancelled' ? 'Replay stopped.' : error instanceof Error ? error.message : 'Replay failed.';
      const outcome = code === 'cancelled' ? 'cancelled' : 'failed';
      options.onState?.({ phase: outcome, elapsedMs: 0, seq: null, message });
      return { outcome, confirmations: [], misses: [{ seq: null, t: 0, code, message }] };
    } finally { if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', hidden); done = true; audio?.close(); }
  })();
  return { finished, cancel: () => { if (done) return; abort.abort(); player?.cancel(); audio?.pause(); }, get done() { return done; } };
}
