import test from 'node:test';
import assert from 'node:assert/strict';
import { appendExamEvent, checkedRevision, publicExamAttempt, recordExamAnswer, repeatedEvent, scoreExamAttempt } from './attempt';
import { scoreExamAnswer } from './score';
import { literalClaims } from './structureAnswer';
import { examinerUtterance } from './voice';
import { examinerPromptPack } from './prompt';
import { buildTtsRequest } from '../gemini';
import { captureExamPoint } from './point';
import { journalTestView as view } from '../journal/fixtures';
import type { ExamAttempt, ExamKey } from './types';
const key: ExamKey = { id: 'CANARY_KEY', orgId: 'org', caseId: 'case', rubricVersion: 'v1', items: [{ id: 'CANARY_FINDING', label: 'CANARY_LABEL', phrases: ['round opacity'], tolerancePixels: 3, point: { sopUID: view.sopUID, frame: 1, imagePoint: { x: 20, y: 20 } } }] };
const attempt: ExamAttempt = { id: 'attempt', orgId: 'org', caseId: 'case', userId: 'learner', keyId: key.id, rubricVersion: key.rubricVersion, status: 'active', answers: [], createdAt: 'synthetic' };
const event = { id: 'hint-1', kind: 'hint' as const, round: 0, at: 'synthetic', fingerprint: 'one' };
test('M10 hints and assistance persist, active receipts exclude all scores/private evidence, and scoring is reproducible', () => {
  const helped = appendExamEvent(attempt, event), answer = { kind: 'report' as const, text: 'A round opacity.' };
  const saved = recordExamAnswer(helped, answer, scoreExamAnswer(key, answer, literalClaims(answer.text)), false, 'synthetic');
  const publicState = publicExamAttempt(saved);
  assert.equal(publicState.hintCount, 1); assert.equal(publicState.answers[0].assisted, true);
  assert.doesNotMatch(JSON.stringify(publicState), /CANARY|correct|score|phrases|tolerancePixels|keyId/);
  const score = scoreExamAttempt(key, saved); assert.equal(score.score, 100); assert.equal(score.assisted, true); assert.equal(score.hintCount, 1);
  assert.deepEqual(score, scoreExamAttempt(key, structuredClone(saved)));
});
test('M10 latest answers and retries never use a best historical score; explicit assistance cannot be cleared by a later flag', () => {
  const answer = { kind: 'report' as const, text: 'Round opacity.' };
  const saved = recordExamAnswer(attempt, answer, scoreExamAnswer(key, answer, literalClaims(answer.text)), true, 'one');
  const retry = appendExamEvent({ ...saved, round: 1 }, { ...event, kind: 'retry', round: 1 });
  assert.equal(scoreExamAttempt(key, retry).score, 0); assert.equal(scoreExamAttempt(key, retry).retryCount, 1);
  const wrong = { kind: 'point' as const, sopUID: view.sopUID, frame: 2, imagePoint: { x: 20, y: 20 } };
  assert.equal(scoreExamAttempt(key, recordExamAnswer(retry, wrong, scoreExamAnswer(key, wrong), false, 'two')).score, 0);
});
test('M10 revision conflicts, closed attempts and reused request IDs fail closed', () => {
  const changed = appendExamEvent(attempt, event);
  assert.throws(() => checkedRevision(changed, 0), /changed/);
  assert.throws(() => checkedRevision({ ...changed, status: 'closed' }), /closed/);
  assert.equal(repeatedEvent(changed, event.id, 'one'), true);
  assert.throws(() => repeatedEvent(changed, event.id, 'other'), /different content/);
});
test('M10 point capture uses rendered SOP/frame and pixels, rejects a stale render or missing geometry', () => {
  const evidence = { snapshot: view, dimensions: [64, 64] as [number, number], imagePoint: { x: 20, y: 20 } };
  const viewer = { getRenderedView: () => ({ snapshot: view, at: 1 }), captureImagePoint: () => evidence };
  assert.deepEqual(captureExamPoint(viewer, .5, .5), { sopUID: view.sopUID, frame: 1, imagePoint: evidence.imagePoint });
  assert.throws(() => captureExamPoint({ ...viewer, getRenderedView: () => ({ snapshot: { ...view, frame: 2 }, at: 2 }) }, .5, .5), /render/);
  assert.throws(() => captureExamPoint(null, .5, .5), /render/);
  const missing = { ...view, sopUID: '' };
  assert.throws(() => captureExamPoint({ getRenderedView: () => ({ snapshot: missing, at: 1 }), captureImagePoint: () => ({ ...evidence, snapshot: missing }) }, .5, .5), /identity/);
  assert.throws(() => captureExamPoint({ ...viewer, captureImagePoint: () => ({ ...evidence, imagePoint: { x: 63.5, y: 20 } }) }, .5, .5), /inside/);
});
test('M10 examiner speech request uses only the neutral prompt pack, with no teaching context or tools', () => {
  const text = examinerUtterance('hint', 1), request = buildTtsRequest(text, 'gemini-3.8-flash-tts', 'Kore', { persona: 'examiner' });
  assert.equal(request.input[0].content[0].annotations[0].style, examinerPromptPack().voiceStyle);
  assert.equal(request.input[0].content[0].text, examinerPromptPack().hints[0]);
  assert.doesNotMatch(JSON.stringify(request), /CANARY|google_search|show_finding|jump_to_key_view|play_guide/);
  assert.throws(() => examinerUtterance('hint', 0)); assert.throws(() => examinerUtterance('CANARY_ANSWER', 2));
});
