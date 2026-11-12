import { ExamError, attemptReceipt, type ExamAttempt, type ExamScore, type ExamKey, type ExamAnswer } from './types';
import { examinerPromptPack } from './prompt';
export type ExamEvent = { id: string; kind: 'answer' | 'hint' | 'retry' | 'close'; at: string; round: number; assisted?: boolean; fingerprint: string };
export function checkedRevision(a: ExamAttempt, revision?: number) {
  if (a.status !== 'active') throw new ExamError('Attempt is closed', 409);
  if (revision !== undefined && revision !== (a.revision ?? 0)) throw new ExamError('Attempt changed. Reload before continuing.', 409);
}
export function repeatedEvent(a: ExamAttempt, id: string, fingerprint: string): boolean {
  const old = a.events?.find(e => e.id === id);
  if (!old) return false;
  if (old.fingerprint !== fingerprint) throw new ExamError('Request ID already used for different content', 409);
  return true;
}
export function appendExamEvent(a: ExamAttempt, event: ExamEvent): ExamAttempt {
  return { ...a, revision: (a.revision ?? 0) + 1, events: [...(a.events ?? []), event] };
}
/** Only learner-owned answers and neutral activity are public before close. */
export function publicExamAttempt(a: ExamAttempt) {
  return { ...attemptReceipt(a), revision: a.revision ?? 0, round: a.round ?? 0,
    hintCount: a.events?.filter(e => e.kind === 'hint').length ?? 0,
    retryCount: a.events?.filter(e => e.kind === 'retry').length ?? 0,
    answers: a.answers.map(r => ({ answer: r.answer, round: r.round ?? 0, assisted: !!r.assisted })),
    activity: (a.events ?? []).map(e => ({ kind: e.kind, at: e.at, round: e.round, assisted: !!e.assisted })),
    prompt: examinerPromptPack().opening,
    ...(a.status === 'closed' && a.finalScore ? { score: a.finalScore } : {}),
  };
}
/** Latest answer in each modality in the current round; never best-of retries. */
export function scoreExamAttempt(key: ExamKey, a: ExamAttempt): ExamScore {
  const answers = a.answers.filter(r => (r.round ?? 0) === (a.round ?? 0));
  const point = answers.filter(r => r.answer.kind === 'point').at(-1), text = answers.filter(r => r.answer.kind !== 'point').at(-1);
  const used = [point, text].filter((r): r is ExamAttempt['answers'][number] => !!r);
  const evidence = key.items.map((_, i) => ({ item: i + 1, correct: used.some(r => r.score.evidence[i]?.correct), assisted: used.some(r => r.score.evidence[i]?.correct && r.assisted) }));
  return { rubricVersion: key.rubricVersion, score: evidence.length ? Math.round(100 * evidence.filter(e => e.correct).length / evidence.length) : 0, evidence,
    assisted: used.some(r => r.assisted), hintCount: a.events?.filter(e => e.kind === 'hint').length ?? 0, retryCount: a.events?.filter(e => e.kind === 'retry').length ?? 0 };
}
export function recordExamAnswer(a: ExamAttempt, answer: ExamAnswer, score: ExamScore, assisted: boolean, at: string): ExamAttempt {
  const helped = assisted || a.answers.some(r => r.assisted) || !!a.events?.some(e => e.kind === 'hint');
  return { ...a, answers: [...a.answers, { answer, score, assisted: helped, round: a.round ?? 0, at }] };
}
