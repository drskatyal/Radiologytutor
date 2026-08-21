"use client";

// Ordered list of cases for a course or playlist page, with a step affordance
// ("Step N") so the sequence reads as a guided path. Reuses CaseCard for the
// tile presentation; animates the list in on mount.

import { motion, useReducedMotion } from "framer-motion";
import { CaseCard } from "./CaseCard";
import type { Author, Case } from "./types";

export function CourseCases({
  cases,
  author,
}: {
  cases: Case[];
  /** Course author — applied as attribution to every case lacking its own. */
  author?: Author;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.ol
      className="flex flex-col gap-3"
      initial="hidden"
      animate="show"
      variants={{ hidden: {}, show: { transition: { staggerChildren: reduce ? 0 : 0.05 } } }}
    >
      {cases.map((c, i) => (
        <motion.li
          key={c.caseId}
          className="flex items-stretch gap-3"
          variants={{
            hidden: reduce ? { opacity: 0 } : { opacity: 0, y: 10 },
            show: { opacity: 1, y: 0 },
          }}
          transition={{ type: "spring", duration: 0.5, bounce: 0.2 }}
        >
          <div className="flex shrink-0 flex-col items-center pt-5">
            <span className="flex h-7 w-7 items-center justify-center rounded-full border border-subtle bg-elevated text-xs font-semibold tabular-nums text-secondary shadow-sm">
              {i + 1}
            </span>
            {i < cases.length - 1 && (
              <span aria-hidden="true" className="mt-1 w-px flex-1 bg-subtle" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <CaseCard data={c} author={author} />
          </div>
        </motion.li>
      ))}
    </motion.ol>
  );
}
