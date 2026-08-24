"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  Check,
  Circle,
  Layers,
  PlayCircle,
} from "lucide-react";
import { Badge, Button, useToast } from "@/components/ui";
import { FilmPlane } from "@/components/brand/FilmPlane";
import { difficultyLabel } from "@/lib/taxonomy";
import type { Author, Case } from "./types";

function CurriculumRow({
  data,
  index,
  done,
  isNext,
  courseId,
  isEnrolled,
  markingId,
  onMarkComplete,
}: {
  data: Case;
  index: number;
  done: boolean;
  isNext: boolean;
  courseId: string;
  isEnrolled: boolean;
  markingId: string | null;
  onMarkComplete: (caseId: string) => void;
}) {
  const meta = [
    data.modality,
    data.system,
    data.difficulty ? difficultyLabel(data.difficulty) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="min-w-0 flex-1">
      <Link
        href={`/case/${data.caseId}?course=${encodeURIComponent(courseId)}`}
        className="group grid grid-cols-[5.5rem_1fr_auto] items-center gap-4 border-b border-subtle py-4 transition-colors hover:bg-surface/40 sm:grid-cols-[7rem_1fr_auto] sm:gap-5"
      >
        <FilmPlane
          modality={data.modality}
          className="h-16 w-[5.5rem] sm:h-[4.5rem] sm:w-28"
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-[0.95rem] font-semibold tracking-tight text-primary sm:text-base">
              <span className="mr-1.5 tabular-nums text-muted">{index}.</span>
              {data.title}
            </h3>
            {isNext && !done && (
              <Badge variant="accent" className="shrink-0">
                Next
              </Badge>
            )}
            {done && (
              <Badge variant="success" className="shrink-0 gap-1">
                <Check className="h-3 w-3" aria-hidden="true" />
                Complete
              </Badge>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-muted sm:text-[13px]">{meta}</p>
          <p className="mt-1.5 inline-flex items-center gap-1 text-xs tabular-nums text-muted">
            <Layers className="h-3 w-3" aria-hidden="true" />
            {data.findings.length} finding{data.findings.length === 1 ? "" : "s"}
          </p>
        </div>
        <span className="hidden items-center gap-1 text-sm font-medium text-secondary transition-colors group-hover:text-accent sm:inline-flex">
          Open
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </Link>
      {isEnrolled && !done && (
        <div className="flex flex-wrap items-center gap-2 border-b border-subtle py-3 pl-[5.5rem] sm:pl-32">
          <Button
            size="sm"
            variant="secondary"
            loading={markingId === data.caseId}
            onClick={() => onMarkComplete(data.caseId)}
          >
            <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Mark complete
          </Button>
          <Link href={`/case/${data.caseId}?course=${encodeURIComponent(courseId)}`}>
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
  );
}

export function CourseCurriculum({
  courseId,
  cases,
  completedCaseIds,
  isEnrolled,
  author: _author,
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
      className="flex flex-col border-t border-subtle"
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
                className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold tabular-nums ${
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
            <CurriculumRow
              data={c}
              index={i + 1}
              done={done}
              isNext={isNext}
              courseId={courseId}
              isEnrolled={isEnrolled}
              markingId={markingId}
              onMarkComplete={markComplete}
            />
          </motion.li>
        );
      })}
    </motion.ol>
  );
}
