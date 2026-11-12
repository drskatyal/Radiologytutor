import test from 'node:test';
import assert from 'node:assert/strict';
import { playJournal } from './player';
import { replayPlan, audioPosition, audioSegments } from './plan';
import { journalTestView as view } from '../journal/fixtures';
import type { RecordedTrack } from '../types';
import type { JournalEntry, RenderAck, ViewCommand } from '../journal/types';
import type { ReplayState } from './types';
const render = (seq: number, t: number): JournalEntry => ({ seq, t, kind: 'render', renderSeq: seq + 1, snapshot: { ...view, sopUID: `1.2.3.${seq + 4}`, renderSeq: seq + 1 }, payload: { displayIndex: 999 } });
const track = (): RecordedTrack => ({ durationMs: 600, start: { sliceIndex: 999, snapshot: view }, events: [], journal: [render(0, 100), render(1, 300)], audioOffsetMs: 150 });
const ack = (c: ViewCommand): RenderAck => ({ ...c, snapshot: { ...c.snapshot, renderSeq: c.snapshot.renderSeq + 20 }, at: 0 });
test('T1/T3: first-frame archive offset is not identity; every recorded SOP/frame is confirmed without rebasing time', async () => {
  let now = 0; const requested: ViewCommand[] = [];
  const plan = replayPlan(track(), false);
  const result = await playJournal(plan, { requestView: async c => { requested.push(c); return ack(c); } }, { now: () => now, sleep: async ms => { now += ms; } }).finished;
  assert.equal(result.outcome, 'completed'); assert.deepEqual(result.confirmations.map(c => c.t), [0, 100, 300]);
  assert.deepEqual(requested.map(c => c.snapshot.sopUID), [view.sopUID, view.sopUID, '1.2.3.5']);
  assert.equal(now, 600); assert.equal(result.misses.length, 0);
});
test('T10: a delayed render holds timeline and audio; resume only after the exact acknowledgement', async () => {
  let now = 0, resolve!: (a: RenderAck) => void, held!: ViewCommand; const schedules: number[][] = [], states: ReplayState[] = [];
  const player = playJournal(replayPlan(track(), true), { requestView: async c => {
    if (c.snapshot.sopUID === '1.2.3.5') { held = c; return new Promise<RenderAck>(r => { resolve = r; }); } return ack(c);
  } }, { audio: { now: () => now, pause() {}, schedule: (a, b) => { schedules.push([a, b]); } }, onState: s => states.push(s), sleep: async ms => { now += ms; } });
  await new Promise(r => setImmediate(r));
  assert.equal(player.state.phase, 'waiting'); assert.equal(player.state.elapsedMs, 300); assert.deepEqual(schedules, [[0, 100], [100, 300]]);
  now += 1800; assert.equal(player.state.elapsedMs, 300); resolve(ack(held));
  const result = await player.finished;
  assert.equal(result.outcome, 'completed'); assert.equal(result.confirmations.at(-1)?.waitMs, 1800); assert.deepEqual(schedules.at(-1), [300, 600]);
  assert.equal(states.at(-1)?.elapsedMs, 600);
});
test('T3: a missing instance fails closed, records a miss and does not request a nearest image', async () => {
  let now = 0; const seen: string[] = [];
  const result = await playJournal(replayPlan(track(), false), { requestView: async c => { seen.push(c.snapshot.sopUID); if (seen.length === 3) throw Object.assign(new Error('missing'), { code: 'missing_identity' }); return ack(c); } }, { now: () => now, sleep: async ms => { now += ms; } }).finished;
  assert.equal(result.outcome, 'failed'); assert.equal(result.misses[0].seq, 1); assert.match(result.misses[0].message, /Image not found: rebind/); assert.equal(now, 300); assert.equal(seen.length, 3);
});
test('T10: timeout and mismatched ack stop with an explicit miss; cancellation ignores a late ack', async () => {
  for (const mode of ['timeout', 'mismatch', 'cancel']) {
    let release!: (a: RenderAck) => void, command!: ViewCommand, cancelled = 0;
    const player = playJournal(replayPlan(track(), false), { cancelView: () => { cancelled++; }, requestView: c => { command = c; return mode === 'mismatch' ? Promise.resolve({ ...ack(c), commandId: 'wrong' }) : new Promise(r => { release = r; }); } }, { timeoutMs: 5 });
    if (mode === 'cancel') player.cancel();
    const result = await player.finished;
    assert.equal(result.outcome, mode === 'cancel' ? 'cancelled' : 'failed'); assert.equal(result.confirmations.length, 0); assert.equal(result.misses.length, 1); assert.ok(cancelled);
    release?.(ack(command)); await new Promise(r => setImmediate(r)); assert.equal(result.confirmations.length, 0);
  }
});
test('T6: shared offset and explicit pause gaps map onto decoded samples; uncertain gaps block exact replay', () => {
  const t = track(); t.journal!.push({ seq: 2, t: 350, kind: 'discontinuity', payload: { stream: 'audio', reason: 'media_pause' } }, { seq: 3, t: 450, kind: 'discontinuity', payload: { stream: 'audio', reason: 'media_resume' } });
  const a = replayPlan(t, true).audio!;
  assert.equal(audioPosition(149, a), null); assert.equal(audioPosition(150, a), 0); assert.equal(audioPosition(400, a), null); assert.equal(audioPosition(500, a), 250);
  assert.deepEqual(audioSegments(0, 600, a), [{ startMs: 150, endMs: 350, positionMs: 0 }, { startMs: 450, endMs: 600, positionMs: 200 }]);
  t.journal!.push({ seq: 4, t: 550, kind: 'discontinuity', payload: { stream: 'audio', reason: 'media_delivery_gap' } });
  assert.throws(() => replayPlan(t, true), /Audio gap detected/);
  const child = track(); child.audioOffsetMs = -200; assert.equal(audioPosition(0, replayPlan(child, true).audio!), 200);
});
test('T2: no silent index fallback or silent downgrade when audio offset is absent', () => {
  const t = track(); delete t.start.snapshot; delete t.journal![0].snapshot; assert.throws(() => replayPlan(t, false), /Image not found/);
  const noOffset = track(); delete noOffset.audioOffsetMs; assert.throws(() => replayPlan(noOffset, true), /offset is missing/);
  const partial = track(); partial.journal = [render(8, 0)]; assert.throws(() => replayPlan(partial, true), /full retained take/);
  const legacy = track(); delete legacy.journal; assert.throws(() => replayPlan(legacy, false), /retained image journal/);
});
test('a manual view change interrupts replay and records the miss rather than completing against stale geometry', async () => {
  let listener!: (v: { snapshot: typeof view; at: number }) => void;
  let now = 0;
  const result = await playJournal(replayPlan(track(), false), {
    onRendered: fn => { listener = fn; return () => {}; }, requestView: async c => ack(c),
  }, { now: () => now, sleep: async ms => { now += ms; listener({ snapshot: { ...view, sopUID: '1.2.3.99' }, at: now }); } }).finished;
  assert.equal(result.outcome, 'failed'); assert.equal(result.misses[0].code, 'view_changed'); assert.equal(result.confirmations.length, 1);
});
test('audio clock suspension during playback stops visibly instead of leaving a frozen infinite loop', async () => {
  let now = 0, suspended = false;
  const result = await playJournal(replayPlan(track(), true), { requestView: async c => ack(c) }, {
    audio: { now: () => { if (suspended) throw Object.assign(new Error('Audio suspended'), { code: 'audio_suspended' }); return now; }, pause() {}, schedule() {} },
    sleep: async ms => { now += ms; suspended = true; },
  }).finished;
  assert.equal(result.outcome, 'failed'); assert.equal(result.misses[0].code, 'audio_suspended');
});
