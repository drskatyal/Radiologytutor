import { audioSegments } from "./plan";
import { ReplayError, type ReplayPlan } from "./types";
import type { ReplayAudio } from "./player";
/** Web Audio schedules sample positions and render-boundary stops on its own clock. */
export class ReplayBufferAudio implements ReplayAudio {
  private sources: AudioBufferSourceNode[] = [];
  private buffer: AudioBuffer | null = null;
  constructor(readonly context = new AudioContext()) {}
  async unlock() { await this.context.resume(); if (this.context.state !== "running") throw new ReplayError("audio_blocked", "Allow audio playback, then retry replay."); }
  async load(bytes: ArrayBuffer) {
    try { this.buffer = await this.context.decodeAudioData(bytes); }
    catch { throw new ReplayError("audio_decode", "Recorded audio could not be decoded. Replay stopped."); }
  }
  now() {
    if (this.context.state !== "running") throw new ReplayError("audio_suspended", "Recorded audio was suspended. Replay stopped; retry when audio is available.");
    return this.context.currentTime * 1000;
  }
  schedule(fromMs: number, untilMs: number, audio: NonNullable<ReplayPlan["audio"]>) {
    this.pause();
    if (!this.buffer || this.context.state !== "running") throw new ReplayError("audio_unavailable", "Recorded audio is unavailable or suspended. Replay stopped.");
    const retainedDuration = audio.endMs - audio.offsetMs - audio.gaps.reduce((n, gap) => n + gap.endMs - gap.startMs, 0);
    if (retainedDuration - this.buffer.duration * 1000 > 100) throw new ReplayError("audio_gap", "Decoded audio is shorter than the retained timeline. Exact replay stopped.");
    const epoch = this.context.currentTime;
    for (const part of audioSegments(fromMs, untilMs, audio)) {
      const offset = part.positionMs / 1000, duration = Math.min((part.endMs - part.startMs) / 1000, this.buffer.duration - offset);
      if (duration <= 0) continue; // at most 100 ms of recorder stop/codec padding, checked above
      const source = this.context.createBufferSource(); source.buffer = this.buffer; source.connect(this.context.destination);
      const when = epoch + (part.startMs - fromMs) / 1000;
      source.start(when, offset, duration); this.sources.push(source);
    }
  }
  pause() { for (const source of this.sources) { try { source.stop(); } catch {} source.disconnect(); } this.sources = []; }
  close() { this.pause(); void this.context.close(); }
}
