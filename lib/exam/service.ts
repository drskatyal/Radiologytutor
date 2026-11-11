import "server-only";
import { randomUUID } from "node:crypto";
import { findActiveExam, readExamAttempt, writeExamAttempt } from "../cases";
import { pinnedExamKey, snapshotExamKey } from "./keyStore";
import { scoreExamAnswer } from "./score";
import { structureAnswer } from "./structureAnswer";
import { ExamError, attemptReceipt, type ExamAnswer } from "./types";

export async function startExam(orgId: string, userId: string, caseId: string) {
  const active = await findActiveExam(orgId, userId, caseId);
  if (active) return attemptReceipt(active);
  const key = await snapshotExamKey(orgId, caseId);
  const attempt = { id: randomUUID(), orgId, userId, caseId, keyId: key.id, rubricVersion: key.rubricVersion,
    status: "active" as const, createdAt: new Date().toISOString(), answers: [] };
  await writeExamAttempt(attempt);
  return attemptReceipt(attempt);
}
export { parseExamAnswer } from "./input";
export async function submitExamAnswer(orgId: string, userId: string, id: string, answer: ExamAnswer, close: boolean) {
  const attempt = await readExamAttempt(orgId, userId, id);
  if (!attempt) throw new ExamError("Attempt not found", 404);
  if (attempt.status !== "active") throw new ExamError("Attempt is closed", 409);
  const key = await pinnedExamKey(orgId, attempt.keyId);
  const claims = answer.kind === "point" ? [] : await structureAnswer(answer.text);
  const score = scoreExamAnswer(key, answer, claims);
  attempt.answers.push({ answer, score });
  if (close) { attempt.status = "closed"; attempt.closedAt = new Date().toISOString(); }
  await writeExamAttempt(attempt);
  return { ...attemptReceipt(attempt), ...(close ? { score } : { accepted: true }) };
}
