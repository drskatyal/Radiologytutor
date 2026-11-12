// Learner-facing catalog must not surface committed demo fixtures.
// The LIDC teach case stays importable (public catalog + seed file) for a
// later recording. It is hidden here while it is still attributed to the
// placeholder author. A case republished under a real author stays visible.
// Studio and admin lists are unfiltered so a teacher can still open the study.

export const PLACEHOLDER_AUTHOR_IDS = new Set(["auth_demo"]);
export const PLACEHOLDER_COURSE_IDS = new Set([
  "course_demo",
  "course_chest_registrar",
]);
export const PLACEHOLDER_PLAYLIST_IDS = new Set(["pl_demo"]);
export const PLACEHOLDER_ASSESSMENT_IDS = new Set(["assess_demo"]);

const PLACEHOLDER_AUTHOR_NAMES = new Set(["demo teacher", "demo student"]);
const PLACEHOLDER_COURSE_TITLES = new Set([
  "foundations of cross-sectional reading",
]);

const PLACEHOLDER_SEED_FILES = new Set([
  "course_demo.json",
  "course_chest_registrar.json",
  "pl_demo.json",
  "assess_demo.json",
  "auth_demo.json",
]);

export function isPlaceholderSeedFile(filename: string): boolean {
  return PLACEHOLDER_SEED_FILES.has(filename);
}

export function isPlaceholderAuthor(author: { id: string; name?: string | null }): boolean {
  if (PLACEHOLDER_AUTHOR_IDS.has(author.id)) return true;
  const name = author.name?.trim().toLowerCase() ?? "";
  return PLACEHOLDER_AUTHOR_NAMES.has(name);
}

export function isPlaceholderCourse(course: {
  id: string;
  title?: string | null;
  authorId?: string | null;
}): boolean {
  if (PLACEHOLDER_COURSE_IDS.has(course.id)) return true;
  if (course.authorId && PLACEHOLDER_AUTHOR_IDS.has(course.authorId)) return true;
  const title = course.title?.trim().toLowerCase() ?? "";
  return PLACEHOLDER_COURSE_TITLES.has(title);
}

export function isPlaceholderPlaylist(playlist: { id: string; title?: string | null }): boolean {
  return PLACEHOLDER_PLAYLIST_IDS.has(playlist.id);
}

export function isPlaceholderAssessment(assessment: { id: string; courseId?: string | null }): boolean {
  if (PLACEHOLDER_ASSESSMENT_IDS.has(assessment.id)) return true;
  return Boolean(assessment.courseId && PLACEHOLDER_COURSE_IDS.has(assessment.courseId));
}

/** Published seed cases that still wear the demo author. */
export function isPlaceholderCatalogCase(item: {
  authorId?: string | null;
}): boolean {
  return Boolean(item.authorId && PLACEHOLDER_AUTHOR_IDS.has(item.authorId));
}

export function toLearnerCatalog<
  T extends {
    cases: { authorId?: string | null }[];
    courses: { id: string; title?: string | null; authorId?: string | null }[];
    playlists: { id: string; title?: string | null }[];
    authors: { id: string; name?: string | null }[];
  },
>(data: T): T {
  return {
    ...data,
    cases: data.cases.filter((item) => !isPlaceholderCatalogCase(item)),
    courses: data.courses.filter((item) => !isPlaceholderCourse(item)),
    playlists: data.playlists.filter((item) => !isPlaceholderPlaylist(item)),
    authors: data.authors.filter((item) => !isPlaceholderAuthor(item)),
  };
}
