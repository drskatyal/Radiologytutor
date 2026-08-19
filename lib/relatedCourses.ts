import type { Course } from "./types";

/** Score how related `candidate` is to `source` for catalog recommendations. */
export function scoreRelatedCourse(source: Course, candidate: Course): number {
  let score = 0;
  if (source.system && candidate.system === source.system) score += 3;
  if (source.difficulty && candidate.difficulty === source.difficulty) score += 2;
  if (source.authorId && candidate.authorId === source.authorId) score += 2;
  return score;
}

/** Sort related courses by relevance score, then title. */
export function sortRelatedCourses(source: Course, candidates: Course[]): Course[] {
  return [...candidates].sort((a, b) => {
    const scoreDiff = scoreRelatedCourse(source, b) - scoreRelatedCourse(source, a);
    if (scoreDiff !== 0) return scoreDiff;
    return a.title.localeCompare(b.title);
  });
}
