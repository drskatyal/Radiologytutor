"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { Check, Circle, PlayCircle } from "lucide-react";
import { Badge, Button, useToast } from "@/components/ui";
import { CaseCard } from "./CaseCard";
import type { Author, Case } from "./types";

export function CourseCurriculum({
  courseId,
  cases,
  completedCaseIds,
  isEnrolled,
  author,
}: {
  courseId: string;
  cases: Case[];
  completedCaseIds: string[];
  isEnrolled: boolean;
  author?: Author;
}) {
  const reduce = useReducedMotion();
  const router = useRouter();
  const { toast } = useToast();
  const [completed, setCompleted] = useState(new Set(completedCaseIds));
  const [markingId, setMarkingId] = useState<string | null>(null);

  const firstIncompleteIndex = cases.findIndex((c) => !completed.has(c.caseId));

  async function markComplete(caseId: string) {
    setMarkingId(caseId);
    try {
      const res = await fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, caseId, markComplete: true }),
      });
      if (res.status === 401) {
        router.push(`/sign-in?next=/course/${encodeURIComponent(courseId)}`);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setCompleted((prev) => new Set([...prev, caseId]));
      toast({ title: "Case marked complete", variant: "success" });
      router.refresh();
    } catch (e) {
      toast({
        title: "Could not update progress",
        description: (e as Error).message,
        variant: "danger",
      });
    } finally {
      setMarkingId(null);
    }
  }

  return (
    <motion.ol
      className="flex flex-col gap-3"
      initial="hidden"
      animate="show"
      variants={{ hidden: {}, show: { transition: { staggerChildren: reduce ? 0 : 0.05 } } }}
    >
      {cases.map((c, i) => {
        const done = completed.has(c.caseId);
        const isNext = i === firstIncompleteIndex;
        return (
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
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold tabular-nums shadow-sm ${
                  done
                    ? "border-success/40 bg-success/15 text-success"
                    : isNext
                      ? "border-accent/50 bg-accent/10 text-accent"
                      : "border-subtle bg-elevated text-secondary"
                }`}
                aria-label={done ? `Step ${i + 1} complete` : `Step ${i + 1}`}
              >
                {done ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Circle className="h-3 w-3 opacity-40" aria-hidden="true" />
                )}
              </span>
              {i < cases.length - 1 && (
                <span aria-hidden="true" className="mt-1 w-px flex-1 bg-subtle" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="relative">
                {isNext && !done && (
                  <Badge variant="accent" className="absolute -top-2 right-2 z-10">
                    Next
                  </Badge>
                )}
                <CaseCard data={c} author={author} index={i + 1} />
              </div>
              {isEnrolled && !done && (
                <div className="mt-2 flex flex-wrap items-center gap-2 pl-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={markingId === c.caseId}
                    onClick={() => markComplete(c.caseId)}
                  >
                    <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Mark complete
                  </Button>
                  <Link href={`/case/${c.caseId}?course=${encodeURIComponent(courseId)}`}>
                    <Button
                      size="sm"
                      variant="ghost"
                      leadingIcon={<PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />}
                    >
                      Start teaching
                    </Button>
                  </Link>
                </div>
              )}
            </div>
          </motion.li>
        );
      })}
    </motion.ol>
  );
}
