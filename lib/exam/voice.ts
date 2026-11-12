import { examinerPromptPack } from './prompt';
import { ExamError } from './types';
/** No case, rubric, arbitrary text or learner identifiers are accepted for examiner speech. */
export function examinerUtterance(kind: unknown, hintCount: number): string {
  const pack = examinerPromptPack();
  if (kind === 'opening') return pack.opening;
  if (kind === 'hint' && hintCount > 0) return pack.hints[Math.min(hintCount - 1, pack.hints.length - 1)];
  throw new ExamError('Request a hint before playing it.', 422);
}
