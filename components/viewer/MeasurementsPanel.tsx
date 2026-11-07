"use client";
// Every measurement in the open study as a list, and as report text: a
// reading aid the desktop viewer does not have. Click a row to go to its
// image, delete one (undoable with Ctrl/⌘+Z, the same history as the image),
// or copy them all as numbered lines for a report. Updates live while open.
// Loaded on first use (CornerstoneViewer, free viewer only).

import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardCopy, Crosshair, Ruler, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { annotationEditing } from "@flowrad/viewer-core";
import {
  measurementReportText,
  measurementRows,
  type AnnotationLike,
  type ImagePlace,
  type MeasurementRow,
} from "@flowrad/viewer-core/measurementReport";

const EVENTS = [
  "CORNERSTONE_TOOLS_ANNOTATION_ADDED",
  "CORNERSTONE_TOOLS_ANNOTATION_MODIFIED",
  "CORNERSTONE_TOOLS_ANNOTATION_COMPLETED",
  "CORNERSTONE_TOOLS_ANNOTATION_REMOVED",
];

interface Props {
  open: boolean;
  onClose: () => void;
  ctx: annotationEditing.EditingContext;
  /** This pane's stack, in order: rows on it can be jumped to. */
  imageIds: readonly string[];
  onJump: (index: number) => void;
  /** A short confirmation on the viewer. */
  onDone: (message: string) => void;
}

export function MeasurementsPanel({ open, onClose, ctx, imageIds, onJump, onDone }: Props) {
  const [version, setVersion] = useState(0);
  const [copied, setCopied] = useState(false);

  // Live: any add / edit / delete re-reads the list.
  useEffect(() => {
    if (!open) return;
    const bump = () => setVersion((v) => v + 1);
    const target = ctx.core.eventTarget as EventTarget;
    for (const name of EVENTS) target.addEventListener(name, bump);
    return () => {
      for (const name of EVENTS) target.removeEventListener(name, bump);
    };
  }, [open, ctx]);

  const indexOf = useMemo(() => new Map(imageIds.map((id, i) => [id, i])), [imageIds]);

  const placeOf = useCallback(
    (imageId: string): ImagePlace | null => {
      try {
        const series = ctx.core.metaData.get("generalSeriesModule", imageId) as { modality?: string; seriesNumber?: number | string } | undefined;
        const image = ctx.core.metaData.get("generalImageModule", imageId) as { instanceNumber?: number } | undefined;
        const at = indexOf.get(imageId);
        const number = at != null ? at + 1 : image?.instanceNumber;
        if (!series && number == null) return null;
        const label = [series?.modality, series?.seriesNumber != null && series.seriesNumber !== "" ? `Se ${series.seriesNumber}` : ""].filter(Boolean).join(" ") || "Series";
        return { series: label, image: number ?? 0 };
      } catch {
        return null;
      }
    },
    [ctx, indexOf]
  );

  const rows = useMemo<MeasurementRow[]>(() => {
    void version;
    if (!open) return [];
    try {
      const all = ctx.tools.annotation.state.getAllAnnotations() as AnnotationLike[];
      return measurementRows(all, placeOf);
    } catch {
      return [];
    }
  }, [open, ctx, placeOf, version]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    const text = measurementReportText(rows);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      onDone(`${rows.length} measurement${rows.length === 1 ? "" : "s"} copied as text`);
    } catch {
      onDone("Copy not allowed here: select the text in the list instead");
    }
  };

  const remove = (row: MeasurementRow) => {
    const all = ctx.tools.annotation.state.getAllAnnotations() as (AnnotationLike & { annotationUID?: string })[];
    const target = all.find((a) => a.annotationUID === row.uid);
    if (!target) return;
    annotationEditing.remove(ctx, [target as annotationEditing.AnnotationLike]);
    onDone(`${row.kind} deleted · Ctrl+Z to undo`);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Measurements"
      description={rows.length ? `${rows.length} in this study. Click one to go to its image.` : undefined}
      size="md"
      tone="reading"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void copy()} disabled={!rows.length} leadingIcon={<ClipboardCopy className="h-4 w-4" aria-hidden />}>
            {copied ? "Copied" : "Copy as report text"}
          </Button>
        </>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={<Ruler className="h-5 w-5" aria-hidden />}
          title="No measurements yet"
          description="Lengths, angles, ROIs and arrows you draw on any series appear here, ready to copy into a report."
        />
      ) : (
        <ol className="flex max-h-[55vh] flex-col divide-y divide-subtle overflow-y-auto rounded-lg border border-subtle" data-testid="measurements-list">
          {rows.map((row, i) => {
            const at = indexOf.get(row.imageId);
            const here = at != null;
            return (
              <li key={row.uid} className="flex items-center gap-2 px-2 py-1.5">
                <button
                  type="button"
                  disabled={!here}
                  onClick={() => {
                    if (at == null) return;
                    onJump(at);
                    onClose();
                  }}
                  title={here ? "Go to this image" : "On another series: open that series to see it"}
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className="w-5 shrink-0 pt-px text-right text-xs tabular-nums text-muted">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-primary">
                      {row.label ? (
                        <>
                          <span className="font-medium">{row.label}</span> <span className="text-secondary">· {row.kind}</span>
                        </>
                      ) : (
                        <span className="font-medium">{row.kind}</span>
                      )}
                    </span>
                    <span className="block text-sm tabular-nums text-secondary" data-testid="measurement-value">
                      {row.value}
                    </span>
                  </span>
                  <span className="shrink-0 pt-px text-xs tabular-nums text-muted">
                    {row.place ? `${row.place.series} · Im ${row.place.image}` : "—"}
                  </span>
                  {here ? <Crosshair className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" aria-hidden /> : null}
                </button>
                <IconButton aria-label={`Delete ${row.label ?? row.kind} ${i + 1}`} size="sm" variant="danger" onClick={() => remove(row)}>
                  <Trash2 aria-hidden />
                </IconButton>
              </li>
            );
          })}
        </ol>
      )}
    </Modal>
  );
}
