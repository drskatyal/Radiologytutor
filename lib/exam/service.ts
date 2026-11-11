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
export function parseExamAnswer(raw: unknown): ExamAnswer {
  if (!raw || typeof raw !== "object") throw new ExamError("Answer required", 400);
  const a = raw as Record<string, unknown>;
  if ((a.kind === "text" || a.kind === "report") && typeof a.text === "string" && a.text.trim() && a.text.length <= 20000) return { kind: a.kind, text: a.text.trim() };
  if (a.kind === "point" && typeof a.sopUID === "string" && Number.isInteger(a.frame) && Number(a.frame) >= 1 && a.imagePoint && typeof a.imagePoint === "object") {
    const p = a.imagePoint as Record<string, unknown>;
    if (typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0) return { kind: "point", sopUID: a.sopUID, frame: Number(a.frame), imagePoint: { x: p.x, y: p.y } };
  }
  throw new ExamError("Invalid answer", 400);
}
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
