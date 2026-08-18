import { listAuthors, listRelatedCourses } from "@/lib/cases";
import type { Course } from "@/lib/types";
import { CoursesRail } from "./Rails";

/** Related courses rail for a course detail page. */
export async function RelatedCourses({
  orgId,
  course,
  limit = 6,
}: {
  orgId: string;
  course: Course;
  limit?: number;
}) {
  const [related, authors] = await Promise.all([
    listRelatedCourses(orgId, course, limit),
    listAuthors(orgId),
  ]);
  if (related.length === 0) return null;

  const authorById = Object.fromEntries(authors.map((a) => [a.id, a]));

  return (
    <CoursesRail
      courses={related}
      authorById={authorById}
      title="Related courses"
      description="More teaching sequences you might like."
    />
  );
}
