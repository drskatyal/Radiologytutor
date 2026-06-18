"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, BookOpen, GraduationCap, ListMusic, Layers } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { difficultyBadgeVariant, difficultyLabel } from "@/lib/taxonomy";
import type { Author, Course, Playlist } from "./types";

/** A horizontal, scrollable row of tiles (Netflix/Spotify-style). */
function Rail({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 font-display text-base font-semibold tracking-tight text-primary">
        <span className="text-accent [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
        {title}
      </h2>
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
  courses,
  authorById,
}: {
  courses: Course[];
  authorById: Record<string, Author>;
}) {
  const reduce = useReducedMotion();
  if (courses.length === 0) return null;
  return (
    <Rail title="Courses" icon={<GraduationCap />}>
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
                  {author && <span className="truncate text-xs">{author.name}</span>}
                </div>
              </Card>
            </Link>
          </motion.div>
        );
      })}
    </Rail>
  );
}

/** Playlists rail — curated, ordered case lists. */
export function PlaylistsRail({ playlists }: { playlists: Playlist[] }) {
  const reduce = useReducedMotion();
  if (playlists.length === 0) return null;
  return (
    <Rail title="Continue" icon={<ListMusic />}>
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
