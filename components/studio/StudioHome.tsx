"use client";

// Studio home — role overview: publish status, my cases, my courses, record.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CircleAlert,
  GraduationCap,
  LayoutGrid,
  Mic,
  PenLine,
  Plus,
  Stethoscope,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageContainer,
  SectionHeading,
  Skeleton,
} from "@/components/ui";
import { StudioHeader } from "./StudioHeader";
import { fetchCases, fetchCourses } from "@/components/admin/api";
import type { AdminCaseRow, Course } from "@/components/admin/types";

export function StudioHome() {
  const [cases, setCases] = useState<AdminCaseRow[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [cs, co] = await Promise.all([fetchCases(), fetchCourses()]);
      setCases(cs);
      setCourses(co);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const published = useMemo(() => cases.filter((c) => c.status === "published"), [cases]);
  const drafts = useMemo(() => cases.filter((c) => c.status === "draft"), [cases]);
  const recordTarget = drafts[0] ?? cases.find((c) => c.findingCount === 0);

  return (
    <div className="animate-fade-in">
      <StudioHeader active="overview" />
      <PageContainer className="flex flex-col gap-8">
        {loading ? (
          <OverviewSkeleton />
        ) : error ? (
          <EmptyState
            icon={<CircleAlert aria-hidden="true" />}
            title="Couldn't load your studio"
            description={error}
            action={
              <Button variant="secondary" onClick={load}>
                Retry
              </Button>
            }
          />
        ) : (
          <>
            <section className="flex flex-col gap-4">
              <SectionHeading
                title="Publish status"
                description="Drafts stay private until you publish. Record a walk-through before students see a case."
                aside={
                  recordTarget ? (
                    <Link href={`/studio/cases/${encodeURIComponent(recordTarget.caseId)}/record`}>
                      <Button
                        size="sm"
                        variant="secondary"
                        leadingIcon={<Mic className="h-4 w-4" aria-hidden="true" />}
                      >
                        Continue recording
                      </Button>
                    </Link>
                  ) : (
                    <Link href="/studio/new">
                      <Button
                        size="sm"
                        variant="secondary"
                        leadingIcon={<Mic className="h-4 w-4" aria-hidden="true" />}
                      >
                        Record a case
                      </Button>
                    </Link>
                  )
                }
              />
              <div className="grid gap-4 sm:grid-cols-3">
                <StatusLink
                  href="/studio/cases"
                  label="Published cases"
                  value={published.length}
                  hint="Visible in the library"
                />
                <StatusLink
                  href="/studio/cases"
                  label="Drafts"
                  value={drafts.length}
                  hint="Still in the reading room"
                />
                <StatusLink
                  href="/studio/courses"
                  label="Courses"
                  value={courses.length}
                  hint="Sequences you teach"
                />
              </div>
            </section>

            <section className="flex flex-col gap-4">
              <SectionHeading
                icon={<LayoutGrid aria-hidden="true" />}
                title="My cases"
                description="Edit findings, record, or publish."
                aside={
                  <Link
                    href="/studio/cases"
                    className="text-sm font-medium text-secondary transition-colors hover:text-accent"
                  >
                    View all
                  </Link>
                }
              />
              {cases.length === 0 ? (
                <EmptyState
                  icon={<Stethoscope aria-hidden="true" />}
                  title="No cases yet — teach your first study"
                  description="Upload a DICOM study, mark the findings, and record your read."
                  action={
                    <Link href="/studio/new">
                      <Button leadingIcon={<Plus className="h-4 w-4" aria-hidden="true" />}>
                        Create a case
                      </Button>
                    </Link>
                  }
                />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {cases.slice(0, 6).map((c) => (
                    <CaseSummary key={c.caseId} c={c} />
                  ))}
                </div>
              )}
            </section>

            <section className="flex flex-col gap-4">
              <SectionHeading
                icon={<GraduationCap aria-hidden="true" />}
                title="My courses"
                description="Group cases into a teaching sequence."
                aside={
                  <Link
                    href="/studio/courses"
                    className="text-sm font-medium text-secondary transition-colors hover:text-accent"
                  >
                    Manage courses
                  </Link>
                }
              />
              {courses.length === 0 ? (
                <EmptyState
                  icon={<GraduationCap aria-hidden="true" />}
                  title="No courses yet"
                  description="Bundle published cases into a course students can start in one click."
                  action={
                    <Link href="/studio/courses">
                      <Button variant="secondary">Open courses</Button>
                    </Link>
                  }
                />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {courses.slice(0, 6).map((course) => (
                    <CourseSummary key={course.id} course={course} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </PageContainer>
    </div>
  );
}

function StatusLink({
  href,
  label,
  value,
  hint,
}: {
  href: string;
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <Link href={href} className="block h-full">
      <Card interactive className="flex h-full flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
        <p className="font-display text-2xl font-semibold tabular-nums text-primary">{value}</p>
        <p className="text-xs text-muted">{hint}</p>
      </Card>
    </Link>
  );
}

function CaseSummary({ c }: { c: AdminCaseRow }) {
  return (
    <Card className="flex h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold text-primary">{c.title}</h3>
        <Badge variant={c.status === "published" ? "success" : "warning"}>{c.status}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="neutral">{c.modality}</Badge>
        <Badge variant={c.findingCount > 0 ? "accent" : "neutral"}>
          {c.findingCount} finding{c.findingCount === 1 ? "" : "s"}
        </Badge>
      </div>
      <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
        <Link href={`/studio/cases/${encodeURIComponent(c.caseId)}`}>
          <Button size="sm" variant="secondary" leadingIcon={<PenLine className="h-3.5 w-3.5" aria-hidden="true" />}>
            Edit
          </Button>
        </Link>
        {c.status === "draft" && (
          <Link href={`/studio/cases/${encodeURIComponent(c.caseId)}/record`}>
            <Button size="sm" variant="ghost" leadingIcon={<Mic className="h-3.5 w-3.5" aria-hidden="true" />}>
              Record
            </Button>
          </Link>
        )}
      </div>
    </Card>
  );
}

function CourseSummary({ course }: { course: Course }) {
  return (
    <Link href={`/course/${course.id}`} className="block h-full">
      <Card interactive className="flex h-full flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold text-primary">{course.title}</h3>
          <Badge variant={course.status === "published" ? "success" : "warning"}>{course.status}</Badge>
        </div>
        {course.description && (
          <p className="line-clamp-2 text-xs leading-relaxed text-muted">{course.description}</p>
        )}
        <p className="mt-auto pt-1 text-xs tabular-nums text-muted">
          {course.caseIds.length} case{course.caseIds.length === 1 ? "" : "s"}
        </p>
      </Card>
    </Link>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-12" />
            <Skeleton className="h-3 w-32" />
          </Card>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="flex flex-col gap-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-8 w-full" />
          </Card>
        ))}
      </div>
    </div>
  );
}
