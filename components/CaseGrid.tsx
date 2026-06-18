"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Layers, Stethoscope } from "lucide-react";
import { Badge, Card } from "@/components/ui";

export interface CaseCardData {
  caseId: string;
  title: string;
  modality: string;
  specialty?: string;
  status?: "draft" | "published";
  findingCount: number;
}

/**
 * Animated grid of teaching-case tiles for the landing page. Client component
 * so cards can stagger in on mount and lift on hover. Pure presentation — data
 * is fetched server-side and passed in.
 */
export function CaseGrid({ cases }: { cases: CaseCardData[] }) {
  const reduce = useReducedMotion();

  return (
    <motion.ul
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: reduce ? 0 : 0.05 } },
      }}
    >
      {cases.map((c) => (
        <motion.li
          key={c.caseId}
          variants={{
            hidden: reduce ? { opacity: 0 } : { opacity: 0, y: 12 },
            show: { opacity: 1, y: 0 },
          }}
          transition={{ type: "spring", duration: 0.5, bounce: 0.2 }}
        >
          <Link href={`/case/${c.caseId}`} className="group block h-full">
            <Card
              interactive
              className="flex h-full flex-col gap-3 overflow-hidden"
            >
              {/* Accent seam revealed on hover for a premium lift. */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/0 to-transparent transition-colors duration-300 group-hover:via-accent/60"
              />
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-display text-base font-semibold tracking-tight text-primary">
                  {c.title}
                </h3>
                {c.status === "draft" && <Badge variant="warning">Draft</Badge>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="accent" className="gap-1.5">
                  <Stethoscope className="h-3 w-3" />
                  {c.modality || "—"}
                </Badge>
                {c.specialty && <Badge>{c.specialty}</Badge>}
              </div>
              <div className="mt-auto flex items-center justify-between pt-2 text-sm text-muted">
                <span className="inline-flex items-center gap-1.5 tabular-nums">
                  <Layers className="h-3.5 w-3.5" />
                  {c.findingCount} finding{c.findingCount === 1 ? "" : "s"}
                </span>
                <span className="inline-flex items-center gap-1 font-medium text-secondary transition-colors group-hover:text-accent">
                  Start
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </div>
            </Card>
          </Link>
        </motion.li>
      ))}
    </motion.ul>
  );
}
