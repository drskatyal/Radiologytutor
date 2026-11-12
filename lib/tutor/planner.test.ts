import test from 'node:test';
import assert from 'node:assert/strict';
import { runTeachingPlan } from '../gemini';
import { planInput } from '../fixtures/gemini/inputs';

test('M9 planner request exposes ack-capable commands only and preserves the entire valid ordered list (mocked)', async () => {
  const original = globalThis.fetch, key = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'synthetic-test-key';
  let body: any, calls = [{ name: 'show_finding', args: { findingId: 'synthetic-finding' } }, { name: 'set_window', args: { windowWidth: 400, windowCenter: 40 } }, { name: 'set_zoom', args: { zoom: 2 } }];
  globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ candidates: [{ content: { parts: [{ text: 'Synthetic comparison.' }, ...calls.map(functionCall => ({ functionCall }))] } }] }); }) as typeof fetch;
  try {
    const plan = await runTeachingPlan({ ...planInput, renderConfirmed: true });
    assert.deepEqual(plan.actions.map(a => a.type), ['show_finding', 'set_window', 'zoom_to']);
    assert.deepEqual(plan.action, plan.actions[0]);
    const names = body.tools.flatMap((t: any) => (t.functionDeclarations ?? []).map((d: any) => d.name));
    assert.ok(names.includes('show_finding')); assert.ok(names.includes('point_to'));
    for (const name of ['play_guide', 'draw_circle', 'draw_arrow', 'place_card']) assert.ok(!names.includes(name));
    const declarations = body.tools.flatMap((t: any) => t.functionDeclarations ?? []);
    assert.deepEqual(Object.keys(declarations.find((d: any) => d.name === 'set_zoom').parameters.properties), ['zoom']);
    // No silent partial execution if a model ignores the offered schema.
    calls = [...calls, { name: 'point_to', args: { x_pct: .5, y_pct: .5 } } as any];
    await assert.rejects(() => runTeachingPlan({ ...planInput, renderConfirmed: true }), /Unsupported/);
    calls = [{ name: 'set_series', args: { seriesInstanceUID: 'foreign' } } as any];
    await assert.rejects(() => runTeachingPlan({ ...planInput, renderConfirmed: true, seriesAllowlist: ['approved-series'] }), /allowlist/);
    calls = [{ name: 'set_zoom', args: { zoom: '2' } } as any];
    await assert.rejects(() => runTeachingPlan({ ...planInput, renderConfirmed: true }), /allowed range/);
  } finally { globalThis.fetch = original; if (key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = key; }
});
