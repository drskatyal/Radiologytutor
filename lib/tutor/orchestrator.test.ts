import test from 'node:test';
import assert from 'node:assert/strict';
import { TutorOrchestrator } from './orchestrator';
import { journalTestView as view } from '../journal/fixtures';
import type { RenderAck, ViewCommand, ViewerSnapshot } from '../journal/types';
import type { TutorCommand, TutorStep } from './commands';
const flush = () => new Promise(r => setImmediate(r));
const step = (command: TutorCommand): TutorStep => ({ command, findingId: 'one', anchorId: 'approved-v1', snapshot: view });
test('P0-8 every action is sequential; delayed render blocks speech and the next action', async () => {
  let current = view, release!: (a: RenderAck) => void, pending!: ViewCommand;
  const log: string[] = [];
  const queue = new TutorOrchestrator({ viewer: () => ({ getRenderedView: () => ({ snapshot: current, at: 0 }), requestView: c => { pending = c; log.push('request'); return new Promise(r => { release = r; }); } }), resolve: async c => { log.push(`resolve:${c.type}`); return step(c); }, speak: async text => { log.push(`speak:${text}`); }, stopSpeech() {} });
  const run = queue.run([{ text: 'First.', actions: [{ type: 'show_finding', findingId: 'one' }, { type: 'zoom', zoom: 2 }] }, { text: 'Second.', actions: [{ type: 'set_window', ww: 400, wc: 40 }] }]);
  await flush(); assert.deepEqual(log, ['resolve:show_finding', 'request']);
  for (let i = 0; i < 3; i++) { current = pending.snapshot; release({ ...pending, at: 0 }); await flush(); if (i === 0) assert.equal(log.some(s => s.startsWith('speak:')), false); }
  assert.equal(await run, 'completed'); assert.deepEqual(log.filter(s => s === 'request' || s.startsWith('speak:')), ['request', 'request', 'speak:First.', 'request', 'speak:Second.']);
});
test('wrong/reordered acknowledgement, timeout, missing image and revoked approval never release speech', async () => {
  for (const kind of ['wrong-id', 'wrong-frame', 'missing', 'timeout', 'revoked']) {
    let spoke = 0, resolved = 0; const states: string[] = [];
    const queue = new TutorOrchestrator({ timeoutMs: 5, viewer: () => ({ getRenderedView: () => ({ snapshot: view, at: 0 }), requestView: async c => {
      if (kind === 'timeout') return new Promise(() => {}); if (kind === 'missing') throw new Error('SOP missing');
      return { ...c, at: 0, ...(kind === 'wrong-id' ? { commandId: 'earlier-turn' } : {}), snapshot: kind === 'wrong-frame' ? { ...view, frame: 2 } : c.snapshot };
    } }), resolve: async c => { if (++resolved > 1 && kind === 'revoked') throw new Error('approval stale'); return step(c); }, speak: async () => { spoke++; }, stopSpeech() {}, onState: state => states.push(state) });
    assert.equal(await queue.run([{ text: 'Never early.', actions: [{ type: 'show_finding', findingId: 'one' }] }]), 'failed'); assert.equal(spoke, 0, kind); assert.equal(states.at(-1), 'failed');
  }
});
test('barge-in cancels pending render and audio; stale acknowledgement cannot release speech', async () => {
  let release!: (a: RenderAck) => void, pending!: ViewCommand, cancelled = 0, stopped = 0, spoke = 0;
  const queue = new TutorOrchestrator({ viewer: () => ({ getRenderedView: () => ({ snapshot: view, at: 0 }), cancelView: () => { cancelled++; }, requestView: c => { pending = c; return new Promise(r => { release = r; }); } }), resolve: async c => step(c), speak: async () => { spoke++; }, stopSpeech: () => { stopped++; } });
  const run = queue.run([{ text: 'Stale.', actions: [] }]); await flush(); const generation = queue.currentGeneration; queue.interrupt();
  assert.equal(await run, 'cancelled'); release({ ...pending, at: 0 }); await flush(); assert.equal(spoke, 0); assert.ok(queue.currentGeneration > generation); assert.ok(cancelled && stopped);
});
test('manual view movement while speaking pauses the tutor and drops the remaining actions', async () => {
  let onRender!: (v: { snapshot: ViewerSnapshot; at: number }) => void, started = 0, resolveCount = 0;
  const queue = new TutorOrchestrator({ viewer: () => ({ getRenderedView: () => ({ snapshot: view, at: 0 }), onRendered: fn => { onRender = fn; return () => {}; }, requestView: async c => ({ ...c, at: 0 }) }), resolve: async c => { resolveCount++; return step(c); }, speak: async () => { started++; return new Promise(() => {}); }, stopSpeech() {} });
  const run = queue.run([{ text: 'First.', actions: [] }, { text: 'No second.', actions: [{ type: 'next_in_tour' }] }]);
  await flush(); assert.equal(started, 1); onRender({ snapshot: { ...view, frame: 2 }, at: 0 }); assert.equal(await run, 'cancelled'); assert.equal(resolveCount, 2);
});

test('a failed speech promise or deadline stops the queue without executing the next action', async () => {
  for (const kind of ['reject', 'timeout']) {
    let requests = 0, stopped = 0;
    const queue = new TutorOrchestrator({ speechTimeoutMs: 5, viewer: () => ({ getRenderedView: () => ({ snapshot: view, at: 0 }), requestView: async c => { requests++; return { ...c, at: 0 }; } }), resolve: async c => step(c), speak: async () => { if (kind === 'reject') throw new Error('Synthetic audio failure'); return new Promise(() => {}); }, stopSpeech: () => { stopped++; } });
    assert.equal(await queue.run([{ text: 'First.', actions: [] }, { text: 'Second.', actions: [{ type: 'next_in_tour' }] }]), 'failed');
    assert.equal(requests, 1); assert.ok(stopped > 1);
  }
});

test('an interrupted speech completion cannot finish a later generation or execute its remaining actions', async () => {
  let finish!: () => void, requests = 0, speech = 0;
  const queue = new TutorOrchestrator({ viewer: () => ({ getRenderedView: () => ({ snapshot: view, at: 0 }), requestView: async c => { requests++; return { ...c, at: 0 }; } }), resolve: async c => step(c), speak: async () => { if (++speech === 1) return new Promise<void>(r => { finish = r; }); }, stopSpeech() {} });
  const old = queue.run([{ text: 'Old.', actions: [] }, { text: 'Never.', actions: [{ type: 'next_in_tour' }] }]); await flush();
  const next = queue.run([{ text: 'New.', actions: [] }]); assert.equal(await old, 'cancelled'); assert.equal(await next, 'completed');
  finish(); await flush(); assert.equal(speech, 2); assert.equal(requests, 2);
});
