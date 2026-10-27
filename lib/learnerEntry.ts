/**
 * Where a learner should land, and when a teacher may open Test as student.
 *
 * A real study is a published case that names a DICOM study UID. The bundled
 * offline sample is not that study. Placeholder-author cases (the public LIDC
 * teach) are used only when nothing else has pixels.
 */

import { isPlaceholderCatalogCase } from "./catalogPlaceholders";
import { BUNDLED_STUDY_UID } from "./viewerSource";

export type LearnerStudyCandidate = {
  caseId: string;
  title?: string;
  status?: string;
  authorId?: string | null;
  updatedAt?: string;
  studyRefs?: { studyInstanceUID?: string | null }[] | null;
  findings?: { studyInstanceUID?: string | null }[] | null;
};

function realStudyUid(uid: string | null | undefined): boolean {
  const value = uid?.trim() ?? "";
  return value.length > 0 && value !== BUNDLED_STUDY_UID && !value.startsWith("flowrad.bundled");
}

/** True when the case points at a DICOM study, not the offline sample. */
export function caseDeclaresRealStudy(item: LearnerStudyCandidate): boolean {
  const refs = item.studyRefs ?? [];
  const findings = item.findings ?? [];
  return (
    refs.some((ref) => realStudyUid(ref.studyInstanceUID)) ||
    findings.some((finding) => realStudyUid(finding.studyInstanceUID))
  );
}

/**
 * Published case a learner can open and then start with the microphone.
 * Prefers a non-placeholder author. Falls back to a real study that is still
 * on the demo author so a seeded teach is reachable.
 */
export function selectLearnerStudy<T extends LearnerStudyCandidate>(cases: readonly T[]): T | null {
  const published = cases.filter(
    (item) => (item.status ?? "published") === "published" && caseDeclaresRealStudy(item)
  );
  const preferred = published.filter((item) => !isPlaceholderCatalogCase(item));
  const pool = preferred.length > 0 ? preferred : published;
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0] ?? null;
}

/**
 * Test as student is the teacher hook into the same mic-gated session.
 * Ready means at least one saved finding (record → compile, or a manual add).
 * A separate clinical-importance reorder pass is not required for the hook.
 */
export function teacherCanTestAsStudent(findingCount: number): boolean {
  return findingCount > 0;
}
