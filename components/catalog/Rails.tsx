"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, BookOpen, Building2, GraduationCap, ListMusic, Layers, Users } from "lucide-react";
import { SectionHeading, VerifiedBadge } from "@/components/ui";
import { difficultyLabel } from "@/lib/taxonomy";
import type { Author, Course, Playlist } from "./types";

function Rail({
  id,
  title,
  description,
  icon,
  aside,
  showHeading = true,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  icon: React.ReactNode;
  aside?: React.ReactNode;
  showHeading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-24 flex-col gap-1">
      {showHeading && (
        <SectionHeading icon={icon} title={title} description={description} aside={aside} />
      )}
      <div className="mt-2 flex flex-col">{children}</div>
    </section>
  );
}

const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0 },
};

/** Courses — editorial rows, no cards. */
export function CoursesRail({
  id,
  courses,
  authorById,
  showHeading = true,
  title = "Courses",
  description = "Multi-case teaching sequences, taught end to end.",
  aside,
}: {
  id?: string;
  courses: Course[];
  authorById: Record<string, Author>;
  showHeading?: boolean;
  title?: string;
  description?: string;
  aside?: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  if (courses.length === 0) return null;
  return (
    <Rail
      id={id}
      title={title}
      description={description}
      icon={<GraduationCap />}
      showHeading={showHeading}
      aside={aside}
    >
      {courses.map((course) => {
        const author = course.authorId ? authorById[course.authorId] : undefined;
        const meta = [
          course.difficulty ? difficultyLabel(course.difficulty) : null,
          course.system,
          `${course.caseIds.length} case${course.caseIds.length === 1 ? "" : "s"}`,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <motion.div
            key={course.id}
            initial={reduce ? false : "hidden"}
            animate="show"
            variants={rowVariants}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            <Link
              href={`/course/${course.id}`}
              className="group flex items-start gap-4 border-b border-subtle py-4 transition-colors hover:bg-surface/40"
            >
              <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-subtle bg-imaging text-accent">
                <BookOpen className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-base font-semibold tracking-tight text-primary">
                  {course.title}
                </h3>
                {course.description && (
                  <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted">
                    {course.description}
                  </p>
                )}
                <p className="mt-2 text-xs text-muted">
                  {meta}
                  {author ? ` · ${author.name}` : ""}
                </p>
              </div>
              <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
            </Link>
          </motion.div>
        );
      })}
    </Rail>
  );
}

/** Teachers — editorial rows. */
export function TeachersRail({
  id,
  authors,
  caseCountByAuthor = {},
  courseCountByAuthor = {},
  showHeading = true,
  title = "Teachers",
  description = "Verified radiologists and educators on FlowRad.",
  aside,
}: {
  id?: string;
  authors: Author[];
  caseCountByAuthor?: Record<string, number>;
  courseCountByAuthor?: Record<string, number>;
  showHeading?: boolean;
  title?: string;
  description?: string;
  aside?: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  if (authors.length === 0) return null;
  return (
    <Rail
      id={id}
      title={title}
      description={description}
      icon={<Users />}
      showHeading={showHeading}
      aside={aside}
    >
      {authors.map((author) => {
        const cases = caseCountByAuthor[author.id] ?? 0;
        const courses = courseCountByAuthor[author.id] ?? 0;
        const initials = author.name
          .split(/\s+/)
          .map((w) => w[0])
          .slice(0, 2)
          .join("")
          .toUpperCase();
        return (
          <motion.div
            key={author.id}
            initial={reduce ? false : "hidden"}
            animate="show"
            variants={rowVariants}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            <Link
              href={`/authors/${author.id}`}
              className="group flex items-start gap-4 border-b border-subtle py-4 transition-colors hover:bg-surface/40"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-subtle bg-elevated font-display text-sm font-semibold text-accent">
                {initials}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-display text-base font-semibold tracking-tight text-primary">
                    {author.name}
                  </h3>
                  <VerifiedBadge status={author.verification} />
                </div>
                {author.credentials && (
                  <p className="mt-0.5 text-xs text-muted">{author.credentials}</p>
                )}
                {author.bio && (
                  <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted">
                    {author.bio}
                  </p>
                )}
                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  {author.institution && (
                    <span className="inline-flex items-center gap-1">
                      <Building2 className="h-3 w-3" aria-hidden="true" />
                      {author.institution}
                    </span>
                  )}
                  <span className="tabular-nums">
                    {cases} case{cases === 1 ? "" : "s"}
                    {courses > 0 ? ` · ${courses} course${courses === 1 ? "" : "s"}` : ""}
                  </span>
                </p>
              </div>
              <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
            </Link>
          </motion.div>
        );
      })}
    </Rail>
  );
}

/** Playlists — editorial rows. */
export function PlaylistsRail({
  id,
  playlists,
  showHeading = true,
  title = "Continue",
  description = "Pick up where you left off.",
  aside,
}: {
  id?: string;
  playlists: Playlist[];
  showHeading?: boolean;
  title?: string;
  description?: string;
  aside?: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  if (playlists.length === 0) return null;
  return (
    <Rail
      id={id}
      title={title}
      description={description}
      icon={<ListMusic />}
      showHeading={showHeading}
      aside={aside}
    >
      {playlists.map((pl) => (
        <motion.div
          key={pl.id}
          initial={reduce ? false : "hidden"}
          animate="show"
          variants={rowVariants}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          <Link
            href={`/playlist/${pl.id}`}
            className="group flex items-center gap-4 border-b border-subtle py-4 transition-colors hover:bg-surface/40"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-subtle bg-imaging text-accent">
              <ListMusic className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="font-display text-base font-semibold tracking-tight text-primary">
                {pl.title}
              </h3>
              {pl.description && (
                <p className="mt-1 line-clamp-1 text-sm text-muted">{pl.description}</p>
              )}
              <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs tabular-nums text-muted">
                <Layers className="h-3 w-3" aria-hidden="true" />
                {pl.caseIds.length} case{pl.caseIds.length === 1 ? "" : "s"}
              </p>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
          </Link>
        </motion.div>
      ))}
    </Rail>
  );
}
