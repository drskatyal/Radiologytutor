import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreExamAnswer } from "./score";
import { literalClaims } from "./structureAnswer";
import type { ExamKey, ExamAnswer } from "./types";
const key: ExamKey = { id: "key", orgId: "org", caseId: "case", rubricVersion: "pinned-v1", items: [{ id: "finding", phrases: ["round opacity"], point: { sopUID: "1.2.3", frame: 2, imagePoint: { x: 32, y: 32 } }, tolerancePixels: 3 }] };
test("scores and evidence are deterministic and name the pinned rubric version", () => {
  const answer: ExamAnswer = { kind: "report", text: "A round opacity is present." };
  const a = scoreExamAnswer(key, answer, literalClaims(answer.text));
  assert.deepEqual(a, scoreExamAnswer(key, answer, literalClaims(answer.text)));
  assert.deepEqual(a, { rubricVersion: "pinned-v1", score: 100, evidence: [{ item: 1, correct: true }] });
  assert.equal(scoreExamAnswer(key, { kind: "text", text: "No round opacity" }, literalClaims("No round opacity")).score, 0);
});
test("identical point coordinates on the wrong SOP or frame fail", () => {
  const answer: ExamAnswer = { kind: "point", ...key.items[0].point! };
  assert.equal(scoreExamAnswer(key, answer).score, 100);
  assert.equal(scoreExamAnswer(key, { ...answer, sopUID: "1.2.9" }).score, 0);
  assert.equal(scoreExamAnswer(key, { ...answer, frame: 3 }).score, 0);
  assert.equal(scoreExamAnswer(key, { ...answer, imagePoint: { x: NaN, y: 32 } }).score, 0);
});

test('M10 hints/retries and assistance are reproducible audit evidence; no best-of score after retry', async () => {
  const { appendExamEvent, recordExamAnswer, scoreExamAttempt, publicExamAttempt } = await import('./attempt');
  const answer: ExamAnswer = { kind: 'report', text: 'A round opacity.' };
  const initial = { id: 'attempt', orgId: 'org', userId: 'learner', caseId: 'case', keyId: key.id, rubricVersion: key.rubricVersion, status: 'active' as const, createdAt: 'synthetic', answers: [] };
  const helped = appendExamEvent(initial, { id: 'hint', kind: 'hint', at: 'synthetic', round: 0, fingerprint: 'hint' });
  const saved = recordExamAnswer(helped, answer, scoreExamAnswer(key, answer, literalClaims(answer.text)), false, 'synthetic');
  const score = scoreExamAttempt(key, saved);
  assert.deepEqual(score, scoreExamAttempt(key, structuredClone(saved)));
  assert.equal(score.hintCount, 1); assert.equal(score.assisted, true); assert.equal(score.score, 100);
  assert.equal(publicExamAttempt(saved).score, undefined);
  const retried = appendExamEvent({ ...saved, round: 1 }, { id: 'retry', kind: 'retry', at: 'synthetic', round: 1, fingerprint: 'retry' });
  assert.equal(scoreExamAttempt(key, retried).score, 0);
  const again = recordExamAnswer(retried, answer, scoreExamAnswer(key, answer, literalClaims(answer.text)), false, 'synthetic');
  assert.equal(again.answers.at(-1)?.assisted, true); assert.equal(scoreExamAttempt(key, again).retryCount, 1);
});
