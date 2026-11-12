import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayBufferAudio } from './audio';
function audioContext(duration = 4) {
  const starts: number[][] = []; let stopped = 0;
  const context = { state: 'running', currentTime: 10, destination: {}, resume: async () => {}, close: async () => {}, decodeAudioData: async () => ({ duration }), createBufferSource: () => ({ buffer: null, connect() {}, disconnect() {}, start: (...args: number[]) => starts.push(args), stop: () => { stopped++; } }) };
  return { context, starts, stopped: () => stopped, audio: new ReplayBufferAudio(context as unknown as AudioContext) };
}
test('T6 Web Audio schedules decoded samples after audioOffsetMs and stops at the next render boundary', async () => {
  const { audio, starts, stopped, context } = audioContext(); await audio.unlock(); await audio.load(new ArrayBuffer(1));
  const plan = { offsetMs: 350, endMs: 4350, gaps: [] };
  audio.schedule(150, 1800, plan); assert.deepEqual(starts, [[10.2, 0, 1.45]]);
  audio.pause(); assert.equal(stopped(), 1); context.currentTime = 12;
  audio.schedule(1800, 2800, plan); assert.deepEqual(starts[1], [12, 1.45, 1]); assert.equal(audio.now(), 12000);
  audio.close(); assert.equal(stopped(), 2);
});
test('T6 explicit pauses insert silence; missing/truncated audio or suspended playback fails closed', async () => {
  const { audio, starts, context } = audioContext(); await audio.load(new ArrayBuffer(1));
  audio.schedule(0, 1000, { offsetMs: 100, endMs: 1100, gaps: [{ startMs: 400, endMs: 600 }] });
  assert.deepEqual(starts, [[10.1, 0, .3], [10.6, .3, .4]]);
  context.state = 'suspended'; assert.throws(() => audio.now(), /was suspended/); await assert.rejects(audio.unlock(), /Allow audio/); assert.throws(() => audio.schedule(0, 1, { offsetMs: 0, endMs: 1, gaps: [] }), /suspended/);
  const short = audioContext(.5); await short.audio.load(new ArrayBuffer(1)); assert.throws(() => short.audio.schedule(0, 1000, { offsetMs: 0, endMs: 1000, gaps: [] }), /shorter/);
});
