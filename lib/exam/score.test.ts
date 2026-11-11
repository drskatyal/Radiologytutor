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
