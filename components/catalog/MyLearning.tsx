"use client";

import Link from "next/link";
import { ArrowRight, BookOpen } from "lucide-react";
import { CourseProgressBar } from "@/components/catalog/CourseProgressBar";
import type { Course } from "@/lib/types";

export interface MyLearningCourse extends Course {
  percentComplete?: number;
}

/** Signed-in learner's enrolled courses — editorial rows, not cards. */
export function MyLearning({ courses }: { courses: MyLearningCourse[] }) {
  if (courses.length === 0) return null;

  return (
    <section aria-labelledby="my-learning-heading" className="mb-12">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2
            id="my-learning-heading"
            className="font-display text-lg font-semibold tracking-tight text-primary"
          >
            My learning
          </h2>
          <p className="mt-1 text-sm text-muted">Resume where you left off.</p>
        </div>
        <Link
          href="/learning"
          className="text-xs font-medium text-secondary transition-colors hover:text-accent"
        >
          View all
        </Link>
      </div>
      <ul className="flex flex-col">
        {courses.map((course) => (
          <li key={course.id}>
            <Link
              href={`/course/${course.id}`}
              className="group flex items-center gap-4 border-b border-subtle py-4 transition-colors first:border-t hover:bg-surface/40"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-subtle bg-imaging text-accent">
                <BookOpen className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-base font-semibold tracking-tight text-primary group-hover:text-accent">
                  {course.title}
                </h3>
                {typeof course.percentComplete === "number" && (
                  <CourseProgressBar percent={course.percentComplete} className="mt-2 max-w-xs" />
                )}
              </div>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
