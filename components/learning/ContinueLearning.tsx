"use client";

import Link from "next/link";
import { BookOpen, GraduationCap } from "lucide-react";
import { Badge, Button } from "@/components/ui";
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
    <section aria-labelledby="continue-learning-heading" className="mb-10">
      <div className="mb-4 flex items-end justify-between gap-4">
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
      <ul className="-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:thin]">
        {items.map((item) => {
          const caseId = resumeCaseId(item);
          const href = caseId
            ? `/case/${caseId}?course=${encodeURIComponent(item.course.id)}`
            : `/course/${item.course.id}`;
          return (
            <li key={item.course.id} className="w-[min(100%,20rem)] shrink-0 snap-start">
              <div className="flex h-full flex-col gap-4 rounded-xl border border-subtle bg-elevated p-4 transition-colors hover:border-strong">
                <div className="flex items-start gap-2">
                  <GraduationCap className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                  <div className="min-w-0">
                    <Link
                      href={`/course/${item.course.id}`}
                      className="font-display text-sm font-semibold text-primary transition-colors hover:text-accent"
                    >
                      {item.course.title}
                    </Link>
                    {item.course.description && (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">
                        {item.course.description}
                      </p>
                    )}
                  </div>
                </div>
                <CourseProgressBar percent={item.progress.percentComplete} />
                <Link href={href} className="mt-auto">
                  <Button size="sm" className="w-full">
                    <BookOpen className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Continue
                  </Button>
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
