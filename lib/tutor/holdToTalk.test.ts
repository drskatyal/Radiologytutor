import test from 'node:test';
import assert from 'node:assert/strict';
import { HoldToTalk, bindHoldKeys } from './holdToTalk';
const flush = () => new Promise(r => setImmediate(r));
function setup() {
  let now = 0, starts = 0, stops = 0, interrupts = 0, maximum = () => {};
  const sent: string[] = [], states: string[] = [];
  const hold = new HoldToTalk({ recorder: { start: async () => { starts++; }, stop: async () => { stops++; return 'synthetic'; } }, submit: s => { sent.push(s); }, interrupt: () => { interrupts++; }, now: () => now,
    state: (s, m) => states.push(`${s}:${m ?? ''}`), setTimer: ((fn: () => void) => { maximum = fn; return 1; }) as unknown as typeof setTimeout, clearTimer: (() => {}) as typeof clearTimeout });
  return { hold, sent, states, advance: (ms: number) => { now += ms; }, maximum: () => maximum(), counts: () => [starts, stops, interrupts] };
}
test('hold release sends one bounded recording; repeat, duplicate release and a short tap cannot send again', async () => {
  const s = setup(); s.hold.press(); s.hold.press(true); s.hold.press(); await flush(); s.advance(600); s.hold.release(); s.hold.release('cancel'); await s.hold.settled();
  assert.deepEqual(s.sent, ['synthetic']); assert.deepEqual(s.counts(), [1, 1, 1]);
  s.hold.press(); await flush(); s.advance(100); s.hold.release(); await s.hold.settled(); assert.equal(s.sent.length, 1); assert.match(s.states.at(-1)!, /quarter second/);
});
test('blur, hidden and Escape discard audio; a maximum duration stops and sends exactly once', async () => {
  for (const reason of ['blur', 'hidden', 'escape'] as const) { const s = setup(); s.hold.press(); await flush(); s.advance(500); s.hold.release(reason); await s.hold.settled(); assert.equal(s.sent.length, 0); assert.deepEqual(s.counts(), [1, 1, 2]); }
  const s = setup(); s.hold.press(); await flush(); s.advance(30000); s.maximum(); await s.hold.settled(); assert.equal(s.sent.length, 1); s.hold.release(); assert.equal(s.counts()[1], 1);
});
test('release before microphone permission resolves closes the late stream without sending; denial permits a second start', async () => {
  let grant!: () => void, stops = 0, sent = 0, attempts = 0;
  const hold = new HoldToTalk({ recorder: { start: () => new Promise<void>(r => { grant = r; }), stop: async () => { stops++; return 'audio'; } }, submit: () => { sent++; }, interrupt() {} });
  hold.press(); hold.release(); grant(); await hold.settled(); assert.equal(stops, 1); assert.equal(sent, 0);
  let now = 0;
  const retry = new HoldToTalk({ now: () => now, recorder: { start: async () => { if (++attempts === 1) throw new Error('permission denied'); }, stop: async () => 'audio' }, submit: () => { sent++; }, interrupt() {} });
  retry.press(); await retry.settled(); retry.press(); await flush(); now = 500; retry.release(); await retry.settled(); assert.equal(attempts, 2); assert.equal(sent, 1);
});
test('keyboard binding releases after focus moves and handles repeat, blur, hidden and Escape', () => {
  const win = new EventTarget(), doc = new EventTarget(), events: string[] = [];
  Object.assign(doc, { hidden: true });
  const off = bindHoldKeys(win as Window, doc as Document, { press: repeat => events.push(`press:${repeat}`), release: r => events.push(r ?? 'release') });
  const key = (type: string, values: object) => { const e = new Event(type, { cancelable: true }); Object.assign(e, values); win.dispatchEvent(e); return e; };
  assert.equal(key('keydown', { code: 'Space', repeat: false }).defaultPrevented, true);
  key('keydown', { code: 'Space', repeat: true }); key('keyup', { code: 'Space' }); win.dispatchEvent(new Event('blur')); doc.dispatchEvent(new Event('visibilitychange')); key('keydown', { key: 'Escape' }); off();
  assert.deepEqual(events, ['press:false', 'press:true', 'release', 'blur', 'hidden', 'escape', 'cancel']);
});

test('a submitted question does not keep the microphone locked while transcription is pending', async () => {
  let now = 0, starts = 0, interrupts = 0;
  const hold = new HoldToTalk({ now: () => now, recorder: { start: async () => { starts++; }, stop: async () => 'audio' }, submit: async () => new Promise(() => {}), interrupt: () => { interrupts++; } });
  hold.press(); await flush(); now = 500; hold.release(); await hold.settled();
  hold.press(); await flush(); assert.equal(starts, 2); assert.equal(interrupts, 2); hold.release('escape'); await hold.settled();
});
