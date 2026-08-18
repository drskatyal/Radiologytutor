"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Layers, Stethoscope } from "lucide-react";
import { Badge, Card, VerifiedBadge } from "@/components/ui";
import { difficultyBadgeVariant, difficultyLabel } from "@/lib/taxonomy";
import type { Author, Case } from "./types";

export interface CaseCardProps {
  data: Case;
  /** Author, if attribution should show (resolved by the caller). */
  author?: Author;
  /** Position label, e.g. "1" for an ordered course/playlist row. */
  index?: number;
}

/**
 * A single teaching-case tile for the catalog and the course/author/playlist
 * pages. Shows the taxonomy (difficulty · system · modality) as badges plus
 * author attribution and finding count. Pure presentation.
 */
export function CaseCard({ data, author, index }: CaseCardProps) {
  return (
    <Link href={`/case/${data.caseId}`} className="group block h-full">
      <Card interactive className="flex h-full flex-col gap-3 overflow-hidden">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-subtle/0 transition-colors duration-300 group-hover:bg-accent/50"
        />
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-base font-semibold tracking-tight text-primary">
            {typeof index === "number" && (
              <span className="mr-1.5 tabular-nums text-muted">{index}.</span>
            )}
            {data.title}
          </h3>
          {data.status === "draft" && <Badge variant="warning">Draft</Badge>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {data.difficulty && (
            <Badge variant={difficultyBadgeVariant(data.difficulty)}>
              {difficultyLabel(data.difficulty)}
            </Badge>
          )}
          {data.system && <Badge variant="info">{data.system}</Badge>}
          <Badge variant="accent" className="gap-1.5">
            <Stethoscope className="h-3 w-3" aria-hidden="true" />
            {data.modality || "—"}
          </Badge>
          {data.specialty && <Badge>{data.specialty}</Badge>}
        </div>

        {data.tags && data.tags.length > 0 && (
          <p className="line-clamp-1 text-xs text-muted">
            {data.tags.map((t) => `#${t}`).join("  ")}
          </p>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 pt-2 text-sm text-muted">
          <span className="inline-flex min-w-0 items-center gap-2">
            {author && <AuthorChip author={author} />}
            <span className="inline-flex items-center gap-1.5 tabular-nums">
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
              {data.findings.length}
            </span>
          </span>
          <span className="inline-flex items-center gap-1 font-medium text-secondary transition-colors group-hover:text-accent">
            Teach
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </Card>
    </Link>
  );
}

/** Tiny inline author avatar + name. */
export function AuthorChip({ author }: { author: Author }) {
  const initials = author.name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-elevated text-[9px] font-semibold text-secondary ring-1 ring-inset ring-subtle">
        {initials}
      </span>
      <span className="truncate">{author.name}</span>
      {author.verification === "verified" && (
        <VerifiedBadge status="verified" className="shrink-0" />
      )}
    </span>
  );
}

/** Animated grid wrapper used by the catalog and library pages. */
export function CaseCardGrid({
  cases,
  authorById = {},
}: {
  cases: Case[];
  authorById?: Record<string, Author>;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.ul
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: reduce ? 0 : 0.04 } },
      }}
    >
      {cases.map((c) => (
        <motion.li
          key={c.caseId}
          layout={!reduce}
          variants={{
            hidden: reduce ? { opacity: 0 } : { opacity: 0, y: 12 },
            show: { opacity: 1, y: 0 },
          }}
          transition={{ type: "spring", duration: 0.5, bounce: 0.2 }}
        >
          <CaseCard data={c} author={c.authorId ? authorById[c.authorId] : undefined} />
        </motion.li>
      ))}
    </motion.ul>
  );
}
