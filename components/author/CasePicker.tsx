"use client";

// The case picker: a grid of selectable case tiles shown before a case is
// opened for review. Loading -> shimmer skeletons; empty -> EmptyState.

import { Badge, Button, Card, EmptyState, Skeleton, cn } from "@/components/ui";
import type { CaseData } from "@/lib/types";
import { DocIcon, LayersIcon, PlusIcon } from "./icons";

interface CasePickerProps {
  cases: CaseData[];
  loading: boolean;
  error: string;
  onSelect: (caseId: string) => void;
  /** Start the create-case-from-upload flow (shown on the empty state). */
  onCreate?: () => void;
}

export function CasePicker({
  cases,
  loading,
  error,
  onSelect,
  onCreate,
}: CasePickerProps) {
  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <CaseTileSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={<DocIcon />}
        title="Couldn't load cases"
        description={error}
      />
    );
  }

  if (cases.length === 0) {
    return (
      <EmptyState
        icon={<DocIcon />}
        title="No cases yet"
        description="Upload a DICOM study to create your first teaching case, then record and mark its findings here."
        action={
          onCreate ? (
            <Button leadingIcon={<PlusIcon />} onClick={onCreate}>
              New case
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cases.map((c) => (
        <button
          key={c.caseId}
          type="button"
          onClick={() => onSelect(c.caseId)}
          className={cn(
            "group animate-fade-up text-left focus-visible:outline-none",
            "rounded-xl focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          )}
        >
          <Card
            interactive
            className="h-full transition-all duration-200 group-hover:-translate-y-0.5 group-hover:shadow-md"
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="min-w-0 truncate text-sm font-semibold text-primary">
                {c.title}
              </h3>
              <Badge variant="neutral">{c.modality}</Badge>
            </div>
            <p className="mt-1 truncate text-xs text-muted">{c.caseId}</p>
            <div className="mt-4 flex items-center gap-2">
              <Badge variant={c.findings.length > 0 ? "accent" : "neutral"}>
                <LayersIcon />
                {c.findings.length} finding{c.findings.length === 1 ? "" : "s"}
              </Badge>
              {c.status && (
                <Badge variant={c.status === "published" ? "success" : "warning"}>
                  {c.status}
                </Badge>
              )}
            </div>
          </Card>
        </button>
      ))}
    </div>
  );
}

function CaseTileSkeleton() {
  return (
    <Card className="h-full">
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-5 w-10 rounded-md" />
      </div>
      <Skeleton className="mt-2 h-3 w-20" />
      <Skeleton className="mt-4 h-5 w-24 rounded-md" />
    </Card>
  );
}
