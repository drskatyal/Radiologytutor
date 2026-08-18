"use client";

// Teaching sequence — the organized spine of authoring. Numbered, complete,
// jump-to-slice. Completeness is label + marker (teachable) and teaching points
// (exam-ready). Clicking a row seats the viewer on that finding.

import {
  ChevronDown,
  ChevronUp,
  Columns2,
  Pencil,
  Play,
  Crosshair,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
} from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { Finding } from "@/lib/types";
import {
  casePublishReadiness,
  findingGaps,
  isExamReadyFinding,
  isTeachableFinding,
} from "@/lib/findingQuality";
import { wantsCompare } from "@/lib/findingAnchors";

export function SequenceBoard({
  findings,
  activeId,
  busy,
  onSelect,
  onMove,
  onEdit,
  onDelete,
  onReplay,
  onReRecord,
  onPinCompare,
  pinningId,
}: {
  findings: Finding[];
  activeId?: string | null;
  busy?: boolean;
  onSelect: (finding: Finding) => void;
  onMove: (findingId: string, dir: -1 | 1) => void;
  onEdit: (finding: Finding) => void;
  onDelete: (finding: Finding) => void;
  onReplay: (finding: Finding) => void;
  onReRecord?: (finding: Finding) => void;
  onPinCompare?: (finding: Finding) => void;
  pinningId?: string | null;
}) {
  const readiness = casePublishReadiness(findings);

  return (
    <Card padded={false} className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-primary">
          Teaching sequence
          <span className="rounded-full bg-elevated px-2 py-0.5 text-xs tabular-nums text-muted">
            {readiness.examReady}/{readiness.total} ready
          </span>
        </h2>
      </div>

      {findings.length === 0 ? (
        <EmptyState
          title="No findings yet"
          description="Click the lesion on the image, dictate or type, then save. The sequence is the script the examiner follows."
        />
      ) : (
        <ol className="flex flex-col gap-1.5">
          {findings.map((f, i) => {
            const gaps = findingGaps(f);
            const teachable = isTeachableFinding(f);
            const exam = isExamReadyFinding(f);
            const active = f.id === activeId;
            const hasTrack = !!f.track && (f.track.events?.length ?? 0) > 0;
            return (
              <li key={f.id}>
                <div
                  className={cn(
                    "rounded-lg border px-2.5 py-2 transition-colors",
                    active
                      ? "border-accent/50 bg-accent/10"
                      : "border-subtle bg-surface hover:border-strong"
                  )}
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => onSelect(f)}
                      className="flex min-w-0 flex-1 items-start gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-xs font-semibold tabular-nums text-accent">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-primary">
                          {f.label.trim() || "Untitled finding"}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          {teachable ? (
                            <Badge variant="success">Marked</Badge>
                          ) : (
                            <Badge variant="warning">Needs mark</Badge>
                          )}
                          {exam ? (
                            <Badge variant="neutral">
                              {f.teachingPoints.filter((p) => p.trim()).length} pearl
                              {f.teachingPoints.filter((p) => p.trim()).length === 1
                                ? ""
                                : "s"}
                            </Badge>
                          ) : (
                            <Badge variant="warning">No pearls</Badge>
                          )}
                          {f.sliceIndex != null && (
                            <Badge variant="neutral" className="tabular-nums">
                              Slice {f.sliceIndex + 1}
                            </Badge>
                          )}
                          {wantsCompare(f) && (
                            <Badge variant="accent">Compare</Badge>
                          )}
                          {pinningId === f.id && (
                            <Badge variant="warning">Click compare landing</Badge>
                          )}
                        </span>
                      </span>
                    </button>
                    <div className="flex shrink-0 flex-col items-center gap-0.5">
                      <IconButton
                        size="sm"
                        aria-label="Move finding up"
                        disabled={i === 0}
                        onClick={() => onMove(f.id, -1)}
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton
                        size="sm"
                        aria-label="Move finding down"
                        disabled={i === findings.length - 1}
                        onClick={() => onMove(f.id, 1)}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </IconButton>
                    </div>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-0.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      leadingIcon={<Crosshair className="h-3.5 w-3.5" />}
                      onClick={() => onSelect(f)}
                    >
                      Jump
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      leadingIcon={<Play className="h-3.5 w-3.5" />}
                      onClick={() => onReplay(f)}
                      disabled={!hasTrack || busy}
                    >
                      Replay
                    </Button>
                    {onReRecord && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onReRecord(f)}
                        disabled={busy}
                      >
                        Re-record
                      </Button>
                    )}
                    {onPinCompare && (
                      <Button
                        size="sm"
                        variant={pinningId === f.id ? "secondary" : "ghost"}
                        leadingIcon={<Columns2 className="h-3.5 w-3.5" />}
                        onClick={() => onPinCompare(f)}
                        disabled={busy}
                      >
                        {pinningId === f.id ? "Click image…" : "Compare landing"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      leadingIcon={<Pencil className="h-3.5 w-3.5" />}
                      onClick={() => onEdit(f)}
                    >
                      Edit
                    </Button>
                    <span className="flex-1" />
                    <IconButton
                      size="sm"
                      variant="danger"
                      aria-label="Delete finding"
                      onClick={() => onDelete(f)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {readiness.blockers.length > 0 && findings.length > 0 && (
        <p className="mt-3 text-xs text-warning">{readiness.blockers[0]}</p>
      )}
    </Card>
  );
}
