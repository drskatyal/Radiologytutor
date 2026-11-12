import { gradeIdentityPoint } from "../assessmentGrade";
import type { ExamAnswer, ExamClaim, ExamKey, ExamScore } from "./types";
const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, " ").trim();
export function scoreExamAnswer(key: ExamKey, answer: ExamAnswer, claims: ExamClaim[] = []): ExamScore {
  const affirmative = claims.filter(c => !c.negated).map(c => ` ${normalize(c.text)} `);
  const evidence = key.items.map((item, index) => ({ item: index + 1,
    correct: answer.kind === "point"
      ? !!item.point && gradeIdentityPoint(item.point, answer, item.tolerancePixels)
      : item.phrases.length > 0 && item.phrases.every(phrase => affirmative.some(text => text.includes(` ${normalize(phrase)} `))),
  }));
  return { rubricVersion: key.rubricVersion, score: evidence.length ? Math.round(100 * evidence.filter(e => e.correct).length / evidence.length) : 0, evidence };
}
