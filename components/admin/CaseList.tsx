"use client";

// The admin case list: one row per case with title, modality, specialty, status
// badge, patient, finding/study counts and updated time, plus row actions
// (open in viewer, edit, publish/unpublish, delete). Renders as a table on wide
// screens and stacked cards on narrow ones.

import Link from "next/link";
import { Eye, Pencil, Trash2 } from "lucide-react";
import { Badge, Button, IconButton } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { formatUpdated, STATUS_BADGE } from "./format";
import type { AdminCaseRow } from "./types";

export function CaseList({
  cases,
  busyId,
  onEdit,
  onTogglePublish,
  onDelete,
}: {
  cases: AdminCaseRow[];
  /** caseId currently mutating (disables that row's actions). */
  busyId: string | null;
  onEdit: (c: AdminCaseRow) => void;
  onTogglePublish: (c: AdminCaseRow) => void;
  onDelete: (c: AdminCaseRow) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-subtle bg-elevated shadow-sm">
      {/* Header row (wide screens only). */}
      <div className="hidden grid-cols-[minmax(0,1fr)_5rem_8rem_7rem_5.5rem_auto] items-center gap-4 border-b border-subtle px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted lg:grid">
        <span>Case</span>
        <span>Modality</span>
        <span>Patient</span>
        <span>Status</span>
        <span className="text-right">Findings</span>
        <span className="text-right">Actions</span>
      </div>

      <ul className="divide-y divide-subtle">
        {cases.map((c) => {
          const busy = busyId === c.caseId;
          return (
            <li
              key={c.caseId}
              className={cn(
                "flex flex-col gap-3 px-4 py-3.5 transition-colors hover:bg-surface/40",
                "lg:grid lg:grid-cols-[minmax(0,1fr)_5rem_8rem_7rem_5.5rem_auto] lg:items-center lg:gap-4",
                busy && "opacity-60"
              )}
            >
              {/* Title + specialty */}
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-primary">
                    {c.title}
                  </span>
                  {c.studyCount > 1 && (
                    <Badge variant="info" className="shrink-0">
                      {c.studyCount} studies
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                  {c.specialty && <span className="truncate">{c.specialty}</span>}
                  <span className="lg:hidden">· {c.modality}</span>
                  <span>· Updated {formatUpdated(c.updatedAt)}</span>
                </div>
              </div>

              {/* Modality */}
              <div className="hidden text-sm text-secondary lg:block">
                {c.modality}
              </div>

              {/* Patient */}
              <div className="hidden min-w-0 lg:block">
                {c.patientName ? (
                  <span className="block truncate text-sm text-secondary">
                    {c.patientName}
                  </span>
                ) : (
                  <span className="text-sm text-muted">—</span>
                )}
              </div>

              {/* Status */}
              <div>
                <Badge variant={STATUS_BADGE[c.status]} dot>
                  {c.status === "published" ? "Published" : "Draft"}
                </Badge>
              </div>

              {/* Findings count */}
              <div className="text-sm tabular-nums text-secondary lg:text-right">
                <span className="lg:hidden">Findings: </span>
                {c.findingCount}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-1">
                <Link
                  href={`/case/${encodeURIComponent(c.caseId)}`}
                  aria-label={`Open ${c.title} in viewer`}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-elevated hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas [&_svg]:h-4 [&_svg]:w-4"
                >
                  <Eye aria-hidden="true" />
                </Link>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onTogglePublish(c)}
                  loading={busy}
                  disabled={busy}
                >
                  {c.status === "published" ? "Unpublish" : "Publish"}
                </Button>
                <IconButton
                  aria-label={`Edit ${c.title}`}
                  size="md"
                  onClick={() => onEdit(c)}
                  disabled={busy}
                >
                  <Pencil aria-hidden="true" />
                </IconButton>
                <IconButton
                  aria-label={`Delete ${c.title}`}
                  size="md"
                  variant="danger"
                  onClick={() => onDelete(c)}
                  disabled={busy}
                >
                  <Trash2 aria-hidden="true" />
                </IconButton>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
