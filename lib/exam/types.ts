/** Private rubric snapshots and public attempt receipts are deliberately different types. */
export type ExamPoint = { sopUID: string; frame: number; imagePoint: { x: number; y: number } };
export type ExamAnswer = { kind: "text" | "report"; text: string } | ({ kind: "point" } & ExamPoint);
export type ExamClaim = { text: string; negated: boolean };
export type ExamKey = {
  id: string; orgId: string; caseId: string; rubricVersion: string;
  studyRefs?: Array<{ studyInstanceUID: string; seriesInstanceUIDs: string[] }>;
  items: Array<{ id: string; phrases: string[]; point?: ExamPoint; label?: string; description?: string; teachingPoints?: string[]; approvedVersion?: number; contentHash?: string; tolerancePixels: number }>;
};
export type ExamScore = { rubricVersion: string; score: number; evidence: Array<{ item: number; correct: boolean; assisted?: boolean }>; assisted?: boolean; hintCount?: number; retryCount?: number };
export type ExamAttempt = {
  id: string; orgId: string; userId: string; caseId: string; keyId: string; rubricVersion: string;
  status: "active" | "closed"; createdAt: string; closedAt?: string;
  revision?: number; round?: number; events?: import("./attempt").ExamEvent[]; finalScore?: ExamScore;
  answers: Array<{ answer: ExamAnswer; score: ExamScore; structuredClaims?: ExamClaim[]; assisted?: boolean; round?: number; at?: string }>;
};
export function attemptReceipt(attempt: ExamAttempt) {
  return { id: attempt.id, caseId: attempt.caseId, status: attempt.status,
    rubricVersion: attempt.rubricVersion, answerCount: attempt.answers.length };
}
export class ExamError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
