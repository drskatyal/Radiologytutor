// Pure policy behind lib/studyAccess.ts, kept free of server imports so it is
// unit-testable.
//
// A member who can author in the org (author / admin / owner, or platform
// staff) may read any study the org has registered — that is how a teacher
// builds a draft. A learner may read only the studies a PUBLISHED case of the
// org names. Before this, any member — including the keyless student demo —
// could stream every registered study in the shared demo org, drafts' studies
// included.

export interface StudyReadInput {
  /** The caller may author in the study's org. */
  canAuthor: boolean;
  /** The org has this StudyInstanceUID registered. */
  orgOwnsStudy: boolean;
  /** Study UIDs named by the org's published cases. */
  publishedStudyUids: ReadonlySet<string>;
  studyUid: string;
}

export function studyReadAllowed(input: StudyReadInput): boolean {
  if (!input.orgOwnsStudy) return false;
  if (input.canAuthor) return true;
  return input.publishedStudyUids.has(input.studyUid.trim());
}
