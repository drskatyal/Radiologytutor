import 'server-only';
import { randomUUID } from 'node:crypto';
import { findActiveExam, readExamAttempt, writeExamAttempt, mutateExamAttempt } from '../cases';
import { pinnedExamKey, snapshotExamKey } from './keyStore';
import { scoreExamAnswer } from './score';
import { structureAnswer, literalClaims } from './structureAnswer';
import { ExamError, attemptReceipt, type ExamAnswer, type ExamAttempt, type ExamKey } from './types';
import { parseExamAnswer } from './input';
import { appendExamEvent, checkedRevision, publicExamAttempt, recordExamAnswer, repeatedEvent, scoreExamAttempt } from './attempt';
import { hashContent } from '../findingContent';
import { readFindingMetadata, inventoryFromMetadata } from '../findingInventory';
export { parseExamAnswer } from './input';
export async function startExam(orgId: string, userId: string, caseId: string) {
  const active = await findActiveExam(orgId, userId, caseId);
  if (active) return attemptReceipt(active);
  const key = await snapshotExamKey(orgId, caseId);
  const attempt: ExamAttempt = { id: randomUUID(), orgId, userId, caseId, keyId: key.id, rubricVersion: key.rubricVersion,
    status: 'active', createdAt: new Date().toISOString(), answers: [], revision: 0, round: 0, events: [] };
  await writeExamAttempt(attempt); return attemptReceipt(attempt);
}
export async function ownedExam(orgId: string, userId: string, id: string, active = false) {
  const attempt = await readExamAttempt(orgId, userId, id);
  if (!attempt) throw new ExamError('Attempt not found', 404);
  if (active) checkedRevision(attempt);
  return attempt;
}
export async function getExam(org: string, user: string, id: string) { return publicExamAttempt(await ownedExam(org, user, id)); }
export interface ExamOperation { requestId?: string; revision?: number; assisted?: boolean }
export function parseExamOperation(raw: Record<string, unknown>): ExamOperation {
  if (raw.revision !== undefined && (!Number.isInteger(raw.revision) || Number(raw.revision) < 0)) throw new ExamError('Invalid revision', 400);
  if (raw.requestId !== undefined && (typeof raw.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(raw.requestId))) throw new ExamError('Invalid request ID', 400);
  if (raw.assisted !== undefined && typeof raw.assisted !== 'boolean') throw new ExamError('Invalid assistance flag', 400);
  return { requestId: raw.requestId as string | undefined, revision: raw.revision as number | undefined, assisted: raw.assisted as boolean | undefined };
}
async function validatePoint(key: ExamKey, answer: ExamAnswer) {
  if (answer.kind !== 'point') return;
  let found = 0;
  for (const ref of key.studyRefs ?? []) for (const seriesUID of ref.seriesInstanceUIDs) {
    const anchor = { studyUID: ref.studyInstanceUID, seriesUID, sopUID: answer.sopUID, frame: answer.frame, view: {} };
    const raw = await readFindingMetadata(anchor), inventory = inventoryFromMetadata(anchor, raw);
    const instance = inventory.instances.find(i => i.sopUID === answer.sopUID);
    if (!instance) continue;
    const row = (raw as Array<Record<string, { Value?: unknown[] }>>).find(r => r['00080018']?.Value?.[0] === answer.sopUID)!;
    const rows = Number(row['00280010']?.Value?.[0]), columns = Number(row['00280011']?.Value?.[0]);
    if (answer.frame > instance.frames || !Number.isInteger(rows) || !Number.isInteger(columns) || answer.imagePoint.x > columns - 1 || answer.imagePoint.y > rows - 1) throw new ExamError('Point is outside the displayed image.', 422);
    found++;
  }
  if (found !== 1) throw new ExamError('Point image is unavailable in this examination.', 422);
}
export async function submitExamAnswer(orgId: string, userId: string, id: string, raw: ExamAnswer, close: boolean, options: ExamOperation = {}) {
  const answer = parseExamAnswer(raw), attempt = await ownedExam(orgId, userId, id);
  const requestId = options.requestId ?? randomUUID(), fingerprint = hashContent({ answer, close, assisted: options.assisted === true });
  if (repeatedEvent(attempt, requestId, fingerprint)) return publicExamAttempt(attempt);
  checkedRevision(attempt, options.revision);
  const revision = attempt.revision ?? 0, key = await pinnedExamKey(orgId, attempt.keyId);
  await validatePoint(key, answer);
  const claims = answer.kind === 'point' ? [] : await structureAnswer(answer.text);
  const score = scoreExamAnswer(key, answer, answer.kind === 'point' ? [] : literalClaims(answer.text)), at = new Date().toISOString();
  const next = await mutateExamAttempt(orgId, userId, id, latest => {
    if (repeatedEvent(latest, requestId, fingerprint)) return latest;
    checkedRevision(latest, revision);
    const answered = recordExamAnswer(latest, answer, score, options.assisted === true, at);
    answered.answers.at(-1)!.structuredClaims = claims;
    const next = appendExamEvent(answered, { id: requestId, kind: 'answer', at, round: latest.round ?? 0, assisted: answered.answers.at(-1)!.assisted, fingerprint });
    if (close) { next.status = 'closed'; next.closedAt = at; next.finalScore = scoreExamAttempt(key, next); }
    return next;
  });
  return { ...publicExamAttempt(next), ...(next.status === 'active' ? { accepted: true } : {}) };
}
export async function examAction(org: string, user: string, id: string, action: 'hint' | 'retry' | 'close', options: ExamOperation = {}) {
  const a = await ownedExam(org, user, id), requestId = options.requestId ?? randomUUID(), fingerprint = hashContent({ action });
  if (repeatedEvent(a, requestId, fingerprint)) return publicExamAttempt(a);
  checkedRevision(a, options.revision);
  const key = action === 'close' ? await pinnedExamKey(org, a.keyId) : null;
  const next = await mutateExamAttempt(org, user, id, latest => {
    if (repeatedEvent(latest, requestId, fingerprint)) return latest;
    checkedRevision(latest, a.revision ?? 0);
    if (action === 'close' && !latest.answers.some(r => (r.round ?? 0) === (latest.round ?? 0))) throw new ExamError('Save an answer before finishing.', 422);
    const round = (latest.round ?? 0) + (action === 'retry' ? 1 : 0), at = new Date().toISOString();
    const next = appendExamEvent({ ...latest, round }, { id: requestId, kind: action, at, round, fingerprint });
    if (action === 'close') { next.status = 'closed'; next.closedAt = at; next.finalScore = scoreExamAttempt(key!, next); }
    return next;
  }); return publicExamAttempt(next);
}
export async function revealExam(org: string, user: string, id: string) {
  const a = await ownedExam(org, user, id);
  if (a.status !== 'closed' || await findActiveExam(org, user)) throw new ExamError('Finish active attempts before revealing reference answers.', 409);
  const key = await pinnedExamKey(org, a.keyId);
  return { rubricVersion: key.rubricVersion, items: key.items.map((r, i) => ({ item: i + 1, label: r.label ?? '', description: r.description ?? '', teachingPoints: r.teachingPoints ?? [], phrases: r.phrases, point: r.point, approvedVersion: r.approvedVersion })) };
}
