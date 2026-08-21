"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Layers } from "lucide-react";
import { VerifiedBadge } from "@/components/ui";
import { FilmPlane } from "@/components/brand/FilmPlane";
import { difficultyLabel } from "@/lib/taxonomy";
import type { Author, Case } from "./types";

export interface CaseCardProps {
  data: Case;
  author?: Author;
  index?: number;
}

/**
 * Editorial case row — film plane + title. No card chrome.
 * Used on home featured lists and the library catalog.
 */
export function CaseCard({ data, author, index }: CaseCardProps) {
  const meta = [
    data.modality,
    data.system,
    data.difficulty ? difficultyLabel(data.difficulty) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Link
      href={`/case/${data.caseId}`}
      className="group grid grid-cols-[5.5rem_1fr_auto] items-center gap-4 border-b border-subtle py-4 transition-colors first:border-t hover:bg-surface/40 sm:grid-cols-[7rem_1fr_auto] sm:gap-5"
    >
      <FilmPlane
        modality={data.modality}
        className="h-16 w-[5.5rem] sm:h-[4.5rem] sm:w-28"
      />
      <div className="min-w-0">
        <h3 className="font-display text-[0.95rem] font-semibold tracking-tight text-primary sm:text-base">
          {typeof index === "number" && (
            <span className="mr-1.5 tabular-nums text-muted">{index}.</span>
          )}
          {data.title}
        </h3>
        <p className="mt-1 truncate text-xs text-muted sm:text-[13px]">
          {meta}
          {author ? ` · ${author.name}` : ""}
        </p>
        <div className="mt-1.5 flex items-center gap-3 text-xs text-muted">
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Layers className="h-3 w-3" aria-hidden="true" />
            {data.findings.length} finding{data.findings.length === 1 ? "" : "s"}
          </span>
          {author?.verification === "verified" && (
            <VerifiedBadge status="verified" className="shrink-0" />
          )}
          {data.status === "draft" && (
            <span className="text-warning">Draft</span>
          )}
        </div>
      </div>
      <span className="hidden items-center gap-1 text-sm font-medium text-secondary transition-colors group-hover:text-accent sm:inline-flex">
        Open
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

export function AuthorChip({ author }: { author: Author }) {
  const initials = author.name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-elevated text-[9px] font-semibold text-secondary ring-1 ring-inset ring-subtle">
        {initials}
      </span>
      <span className="truncate">{author.name}</span>
      {author.verification === "verified" && (
        <VerifiedBadge status="verified" className="shrink-0" />
      )}
    </span>
  );
}

/** Editorial list — replaces the old card grid. */
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
      className="flex flex-col"
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: reduce ? 0 : 0.035 } },
      }}
    >
      {cases.map((c) => (
        <motion.li
          key={c.caseId}
          variants={{
            hidden: reduce ? { opacity: 0 } : { opacity: 0, y: 8 },
            show: { opacity: 1, y: 0 },
          }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          <CaseCard data={c} author={c.authorId ? authorById[c.authorId] : undefined} />
        </motion.li>
      ))}
    </motion.ul>
  );
}
