import Link from "next/link";
import { BookOpen, GraduationCap } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import type { Course } from "@/lib/types";

/** Signed-in learner's enrolled courses — one job: resume learning. */
export function MyLearning({ courses }: { courses: Course[] }) {
  if (courses.length === 0) return null;

  return (
    <section aria-labelledby="my-learning-heading" className="mb-10">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2
            id="my-learning-heading"
            className="font-display text-lg font-semibold tracking-tight text-primary"
          >
            My learning
          </h2>
          <p className="mt-1 text-sm text-secondary">Courses you are enrolled in.</p>
        </div>
        <Badge variant="neutral" className="tabular-nums">
          {courses.length}
        </Badge>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {courses.map((course) => (
          <li key={course.id}>
            <Link
              href={`/course/${course.id}`}
              className="group flex h-full flex-col gap-3 rounded-xl border border-subtle bg-elevated p-4 transition-colors hover:border-strong hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <span className="flex items-center gap-2 text-accent">
                <GraduationCap className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="font-display text-sm font-semibold text-primary group-hover:text-accent">
                  {course.title}
                </span>
              </span>
              {course.description && (
                <p className="line-clamp-2 text-sm leading-relaxed text-muted">{course.description}</p>
              )}
              <span className="mt-auto">
                <Button size="sm" variant="secondary" className="pointer-events-none">
                  <BookOpen className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  Continue
                </Button>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
