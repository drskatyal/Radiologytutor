"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, BookOpen, Building2, GraduationCap, ListMusic, Layers, Users } from "lucide-react";
import { Badge, Card, SectionHeading, VerifiedBadge } from "@/components/ui";
import { difficultyBadgeVariant, difficultyLabel } from "@/lib/taxonomy";
import type { Author, Course, Playlist } from "./types";

/** A horizontal, scrollable row of tiles (Netflix/Spotify-style). */
function Rail({
  id,
  title,
  description,
  icon,
  aside,
  /** Hide the rail's own heading when the parent already supplies one. */
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
    <section id={id} className="flex scroll-mt-24 flex-col gap-3">
      {showHeading && (
        <SectionHeading icon={icon} title={title} description={description} aside={aside} />
      )}
      <div className="-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:thin]">
        {children}
      </div>
    </section>
  );
}

const tileVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
};

/** Courses rail — each card links to its course page. */
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
        return (
          <motion.div
            key={course.id}
            initial={reduce ? false : "hidden"}
            animate="show"
            variants={tileVariants}
            transition={{ type: "spring", duration: 0.5, bounce: 0.2 }}
            className="w-72 shrink-0 snap-start"
          >
            <Link href={`/course/${course.id}`} className="group block h-full">
              <Card interactive className="flex h-full flex-col gap-3">
                <div className="flex items-center gap-2 text-accent">
                  <BookOpen className="h-4 w-4" aria-hidden="true" />
                  <span className="text-xs font-medium uppercase tracking-wide text-muted">
                    Course
                  </span>
                </div>
                <h3 className="font-display text-base font-semibold tracking-tight text-primary">
                  {course.title}
                </h3>
                {course.description && (
                  <p className="line-clamp-2 text-sm leading-relaxed text-muted">
                    {course.description}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {course.difficulty && (
                    <Badge variant={difficultyBadgeVariant(course.difficulty)}>
                      {difficultyLabel(course.difficulty)}
                    </Badge>
                  )}
                  {course.system && <Badge variant="info">{course.system}</Badge>}
                </div>
                <div className="mt-auto flex items-center justify-between pt-1 text-sm text-muted">
                  <span className="inline-flex items-center gap-1.5 tabular-nums">
                    <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                    {course.caseIds.length} case{course.caseIds.length === 1 ? "" : "s"}
                  </span>
                  {author && (
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-xs">{author.name}</span>
                      {author.verification === "verified" && (
                        <VerifiedBadge status="verified" className="shrink-0" />
                      )}
                    </span>
                  )}
                </div>
              </Card>
            </Link>
          </motion.div>
        );
      })}
    </Rail>
  );
}

/** Teachers rail — each card links to the public author profile. */
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
        return (
          <motion.div
            key={author.id}
            initial={reduce ? false : "hidden"}
            animate="show"
            variants={tileVariants}
            transition={{ type: "spring", duration: 0.5, bounce: 0.2 }}
            className="w-72 shrink-0 snap-start"
          >
            <Link href={`/authors/${author.id}`} className="group block h-full">
              <Card interactive className="flex h-full flex-col gap-3">
                <div className="flex items-start gap-3">
                  <TeacherAvatar author={author} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="font-display text-base font-semibold tracking-tight text-primary">
                        {author.name}
                      </h3>
                      <VerifiedBadge status={author.verification} />
                    </div>
                    {author.credentials && (
                      <p className="truncate text-xs text-muted">{author.credentials}</p>
                    )}
                  </div>
                </div>
                {author.bio && (
                  <p className="line-clamp-2 text-sm leading-relaxed text-muted">{author.bio}</p>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                  {author.institution && (
                    <Badge variant="neutral" className="gap-1">
                      <Building2 className="h-3 w-3" aria-hidden="true" />
                      <span className="max-w-[10rem] truncate">{author.institution}</span>
                    </Badge>
                  )}
                  {author.subspecialties?.slice(0, 2).map((s) => (
                    <Badge key={s} variant="info">
                      {s}
                    </Badge>
                  ))}
                </div>
                <div className="mt-auto flex items-center justify-between pt-1 text-sm text-muted">
                  <span className="tabular-nums">
                    {cases} case{cases === 1 ? "" : "s"}
                    {courses > 0 && (
                      <>
                        {" · "}
                        {courses} course{courses === 1 ? "" : "s"}
                      </>
                    )}
                  </span>
                  <span className="inline-flex items-center gap-1 font-medium text-secondary transition-colors group-hover:text-accent">
                    Profile
                    <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
              </Card>
            </Link>
          </motion.div>
        );
      })}
    </Rail>
  );
}

function TeacherAvatar({ author }: { author: Author }) {
  const initials = author.name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-elevated font-display text-sm font-semibold text-secondary ring-1 ring-inset ring-subtle">
      {initials}
    </span>
  );
}

/** Playlists rail — curated, ordered case lists. */
export function PlaylistsRail({ playlists }: { playlists: Playlist[] }) {
  const reduce = useReducedMotion();
  if (playlists.length === 0) return null;
  return (
    <Rail
      title="Continue"
      description="Curated, ordered case lists to pick up where you left off."
      icon={<ListMusic />}
    >
      {playlists.map((pl) => (
        <motion.div
          key={pl.id}
          initial={reduce ? false : "hidden"}
          animate="show"
          variants={tileVariants}
          transition={{ type: "spring", duration: 0.5, bounce: 0.2 }}
          className="w-72 shrink-0 snap-start"
        >
          <Link href={`/playlist/${pl.id}`} className="group block h-full">
            <Card interactive className="flex h-full flex-col gap-3">
              <div className="flex items-center gap-2 text-accent">
                <ListMusic className="h-4 w-4" aria-hidden="true" />
                <span className="text-xs font-medium uppercase tracking-wide text-muted">
                  Playlist
                </span>
              </div>
              <h3 className="font-display text-base font-semibold tracking-tight text-primary">
                {pl.title}
              </h3>
              {pl.description && (
                <p className="line-clamp-2 text-sm leading-relaxed text-muted">
                  {pl.description}
                </p>
              )}
              <div className="mt-auto flex items-center justify-between pt-1 text-sm text-muted">
                <span className="inline-flex items-center gap-1.5 tabular-nums">
                  <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                  {pl.caseIds.length} case{pl.caseIds.length === 1 ? "" : "s"}
                </span>
                <span className="inline-flex items-center gap-1 font-medium text-secondary transition-colors group-hover:text-accent">
                  Open
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </div>
            </Card>
          </Link>
        </motion.div>
      ))}
    </Rail>
  );
}
