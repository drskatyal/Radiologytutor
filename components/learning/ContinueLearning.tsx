"use client";

import Link from "next/link";
import { ArrowRight, BookOpen } from "lucide-react";
import { Badge } from "@/components/ui";
import { CourseProgressBar } from "@/components/catalog/CourseProgressBar";
import type { Course, Progress } from "@/lib/types";

export interface ContinueLearningItem {
  course: Course;
  progress: Progress;
}

function resumeCaseId(item: ContinueLearningItem): string | undefined {
  const { course, progress } = item;
  if (progress.lastOpenedCaseId && course.caseIds.includes(progress.lastOpenedCaseId)) {
    return progress.lastOpenedCaseId;
  }
  const next = course.caseIds.find((id) => !progress.completedCaseIds.includes(id));
  return next ?? course.caseIds[0];
}

export function ContinueLearning({ items }: { items: ContinueLearningItem[] }) {
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="continue-learning-heading">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2
            id="continue-learning-heading"
            className="font-display text-lg font-semibold tracking-tight text-primary"
          >
            Continue learning
          </h2>
          <p className="mt-1 text-sm text-secondary">Pick up where you left off.</p>
        </div>
        <Badge variant="neutral" className="tabular-nums">
          {items.length}
        </Badge>
      </div>
      <ul className="flex flex-col border-t border-subtle">
        {items.map((item) => {
          const caseId = resumeCaseId(item);
          const href = caseId
            ? `/case/${caseId}?course=${encodeURIComponent(item.course.id)}`
            : `/course/${item.course.id}`;
          return (
            <li key={item.course.id}>
              <Link
                href={href}
                className="group flex items-center gap-4 border-b border-subtle py-4 transition-colors hover:bg-surface/40"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-subtle bg-imaging text-accent">
                  <BookOpen className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="font-display text-base font-semibold tracking-tight text-primary group-hover:text-accent">
                    {item.course.title}
                  </h3>
                  {item.course.description && (
                    <p className="mt-1 line-clamp-1 text-sm text-muted">
                      {item.course.description}
                    </p>
                  )}
                  <CourseProgressBar
                    percent={item.progress.percentComplete}
                    className="mt-2 max-w-xs"
                  />
                </div>
                <span className="hidden items-center gap-1 text-sm font-medium text-secondary transition-colors group-hover:text-accent sm:inline-flex">
                  Continue
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
