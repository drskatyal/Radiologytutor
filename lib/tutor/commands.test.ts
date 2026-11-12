import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTutorCommand, plannerCommand } from './commands';
import { resolveTutorCommand } from './server';
import { rebindPatch } from '../review/server';
import { journalTestView } from '../journal/fixtures';
import { tutorAudio, tutorText } from './input';
import type { Case, Finding } from '../types';
import type { ApprovedToolContext } from '../harness/approvedTools';
const study = JSON.parse(readFileSync('fixtures/synthetic/study.json', 'utf8'));
const instance = study.instances[0], snapshot = { ...journalTestView, studyUID: study.studyUID, seriesUID: instance.seriesUID, sopUID: instance.sopUID };
const f = { id: 'one', order: 1, label: 'Synthetic focus', description: '', teachingPoints: [], state: ' ', marker: { shape: 'circle', x_pct: .5, y_pct: .5 } } as Finding;
const finding = { ...f, ...rebindPatch(f, { snapshot, imagePoint: { x: 20, y: 20 }, dimensions: [64, 64] }, study.instances.filter((i: { seriesUID: string }) => i.seriesUID === instance.seriesUID).map((i: { metadata: unknown }) => i.metadata)) };
const target = { studyUID: snapshot.studyUID, seriesUID: snapshot.seriesUID, sopUID: snapshot.sopUID, frame: 1 };
const context: ApprovedToolContext = { anchors: [{ id: 'approved-one-v1', findingId: 'one', target }], annotations: [], series: [{ studyUID: target.studyUID, seriesUID: target.seriesUID, frameCount: 1, frames: [target] }] };
const data = { findings: [finding] } as Case;
test('M9 typed commands reject free coordinates, invalid ranges and foreign/unapproved identities', () => {
  for (const raw of [{ type: 'show_anchor', anchorId: 'approved-one-v1', x_pct: .4 }, { type: 'zoom', zoom: 11 }, { type: 'set_window', ww: 0, wc: 40 }, { type: 'scroll_to', sopUID: target.sopUID, seriesUID: target.seriesUID, frame: 1.5 }]) assert.throws(() => parseTutorCommand(raw));
  for (const raw of [{ type: 'show_finding', findingId: 'unapproved' }, { type: 'show_anchor', anchorId: 'old-version' }, { type: 'scroll_to', ...target, sopUID: 'foreign' }, { type: 'scroll_to', sopUID: target.sopUID, seriesUID: target.seriesUID, frame: 2 }]) assert.throws(() => resolveTutorCommand(data, context, raw));
  assert.equal(resolveTutorCommand(data, context, { type: 'show_finding', findingId: 'one' }).snapshot.sopUID, target.sopUID);
  assert.equal(resolveTutorCommand(data, context, { type: 'show_anchor', anchorId: 'approved-one-v1' }).shapes![0].imagePoints[0].x, 20);
});
test('P0-8 legacy planner adapter retains all ordered actions; server applies bounded view changes cumulatively', () => {
  const actions = [{ type: 'show_finding', findingId: 'one' }, { type: 'point_to', anchorId: 'approved-one-v1', target }, { type: 'set_window', windowWidth: 1500, windowCenter: -600 }, { type: 'set_zoom', zoom: 2 }].map(plannerCommand);
  assert.equal(actions.length, 4); assert.deepEqual(actions.map(a => a.type), ['show_finding', 'show_anchor', 'set_window', 'zoom']);
  const windowed = resolveTutorCommand(data, context, actions[2], 'one', snapshot), zoomed = resolveTutorCommand(data, context, actions[3], 'one', windowed.snapshot);
  assert.deepEqual(zoomed.snapshot.voi, { ww: 1500, wc: -600 }); assert.equal(zoomed.snapshot.camera.zoom, 2);
  assert.throws(() => plannerCommand({ type: 'point_to', anchorId: 'approved-one-v1', x_pct: .4 }));
  assert.throws(() => resolveTutorCommand(data, context, { type: 'hold' }, 'one', { ...snapshot, frame: 2 }));
});
test('learner audio needs the PHI flag and bounded format; spoken identifiers in the transcript are rejected', () => {
  assert.throws(() => tutorAudio({ base64: 'YQ==', mime: 'audio/webm' }), /patient identifiers/);
  assert.deepEqual(tutorAudio({ base64: 'YQ==', mime: 'audio/webm', phiReviewed: true }), { base64: 'YQ==', mime: 'audio/webm' });
  assert.throws(() => tutorAudio({ base64: 'YQ==', mime: 'application/octet-stream', phiReviewed: true }));
  assert.throws(() => tutorText('PatientName: DOE^JANE')); assert.equal(tutorText('Describe this synthetic contour.'), 'Describe this synthetic contour.');
});

test('M9 highlight uses only a named approved annotation with exact original pixels and spacing provenance', async () => {
  const { namedAnnotation } = await import('../harness/approvedToolContext');
  const evidence = { ...finding.resolvedAnchor!, imagePoints: [{ x: 10, y: 20 }, { x: 20, y: 20 }] };
  const annotation = { tool: 'Length', label: 'Synthetic diameter', resolvedAnchor: evidence };
  const named = namedAnnotation(annotation, target)!;
  assert.ok(named); assert.deepEqual(named.handles, [[10 / 63, 20 / 63], [20 / 63, 20 / 63]]);
  const c = { ...context, annotations: [{ id: `${context.anchors[0].id}/annotation/0`, anchorId: context.anchors[0].id, annotation: named }] };
  const d = { ...data, findings: [{ ...finding, annotations: [annotation] }] };
  const result = resolveTutorCommand(d, c, { type: 'highlight', annotationId: c.annotations[0].id });
  assert.deepEqual(result.shapes![0].imagePoints, evidence.imagePoints);
  assert.deepEqual(result.shapes![0].geometry, evidence.geometry);
  assert.equal(result.snapshot.sopUID, target.sopUID);
  assert.equal(namedAnnotation(annotation, { ...target, frame: 2 }), null);
  assert.throws(() => resolveTutorCommand(d, c, { type: 'highlight', annotationId: 'unapproved' }));
  for (const bad of [{ ...evidence, anchorStatus: 'unresolved' }, { ...evidence, imagePoints: [{ x: 999, y: 0 }] }]) assert.equal(namedAnnotation({ ...annotation, resolvedAnchor: bad }, target), null);
  const malformed = { ...d, findings: [{ ...finding, annotations: [{ ...annotation, resolvedAnchor: { ...evidence, imagePoints: [evidence.imagePoints[0]] } }] }] };
  assert.throws(() => resolveTutorCommand(malformed, c, { type: 'highlight', annotationId: c.annotations[0].id }), /Unsupported/);
});
