"use client";

// Open a DICOM study from this machine. Nothing is uploaded.
//
// The first step of `docs/DESKTOP_PLAN.md`: the free standalone viewer. Drop a
// folder (or a CD mount, or a handful of files) and read it in the same
// Cornerstone viewport the teaching product uses — same scroll feel, same
// window presets, same cine, same measurements, same three-plane MPR.
//
// Everything here is local: `lib/localDicomFiles.ts` parses headers in the
// page and registers the `File` objects with Cornerstone's wadouri file
// manager, so the browser streams pixels off disk on demand. There is no
// network call, no archive, and no account. When this moves into a Tauri
// shell the only part that changes is where the file list comes from.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronUp, FolderOpen, HardDrive, Layers, Maximize2, Minimize2, ShieldCheck } from "lucide-react";
import { Button, EmptyState, IconButton, Panel, Sheet, Spinner } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import {
  openLocalFiles,
  seriesImageIds,
  type LocalOpenProgress,
  type LocalOpenResult,
} from "@/lib/localDicomFiles";
import { describeLocalSeries, type LocalSeries, type LocalStudy } from "@/lib/localStudy";
import type { ViewerSource } from "@/lib/viewerSource";
import { primarySeriesIndexByProtocol } from "@flowrad/viewer-core";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { hapticTick, isSwipeUp } from "@/lib/sheetGesture";
import { NARROW_LAYOUT_MEDIA, requestStageFullscreen } from "@/lib/viewerLayout";

const CornerstoneViewer = dynamic(() => import("@/components/CornerstoneViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex aspect-square w-full items-center justify-center rounded-xl bg-imaging text-white">
      <span className="flex items-center gap-2 text-sm">
        <Spinner size="sm" label="Loading viewer" />
        Loading viewer…
      </span>
    </div>
  ),
});

type Phase =
  | { state: "idle" }
  | { state: "reading"; progress: LocalOpenProgress }
  | { state: "open"; result: LocalOpenResult }
  | { state: "empty"; inspected: number }
  | { state: "error"; message: string };

function formatCount(n: number): string {
  return n.toLocaleString();
}

export function LocalStudyViewer() {
  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const [activeStudy, setActiveStudy] = useState(0);
  const [activeSeries, setActiveSeries] = useState(0);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Phones: the series list is a bottom drawer, and the stage can go fullscreen. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const swipeRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const viewerControls = useRef<CornerstoneControls | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Native fullscreen ends with the system gesture or Escape; follow it.
  useEffect(() => {
    const sync = () => {
      if (!document.fullscreenElement && stageRef.current?.dataset.nativeFullscreen === "true") {
        delete stageRef.current.dataset.nativeFullscreen;
        setExpanded(false);
      }
    };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleExpanded = useCallback(async () => {
    const el = stageRef.current;
    if (!el) return;
    hapticTick();
    if (expanded) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      delete el.dataset.nativeFullscreen;
      setExpanded(false);
      return;
    }
    // Native fullscreen where allowed (Android, desktop); iPhone Safari has
    // none for elements, so the stage covers the page with CSS instead.
    if (await requestStageFullscreen(el)) el.dataset.nativeFullscreen = "true";
    setExpanded(true);
  }, [expanded]);

  // The stage changes shape (square → full screen and back): fit the image to
  // it once the layout settles, so nothing is cropped at the sides.
  useEffect(() => {
    const t = window.setTimeout(() => viewerControls.current?.fit?.(), 250);
    return () => window.clearTimeout(t);
  }, [expanded]);

  const pickSeries = useCallback((index: number) => {
    setActiveSeries(index);
    setDrawerOpen(false);
    hapticTick();
  }, []);

  const ingest = useCallback(async (files: File[]) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setActiveStudy(0);
    setActiveSeries(0);
    setPhase({ state: "reading", progress: { read: 0, accepted: 0, total: files.length } });
    try {
      const result = await openLocalFiles(files, {
        signal: controller.signal,
        onProgress: (progress) => setPhase({ state: "reading", progress }),
      });
      if (controller.signal.aborted) return;
      if (result.studies.length === 0) {
        setPhase({ state: "empty", inspected: files.length });
        return;
      }
      // Open on the series a hanging protocol would read first (CT axial soft
      // tissue, MR T1/T2…, a radiograph's PA view), not just the first listed.
      setActiveSeries(primarySeriesIndexByProtocol(result.studies[0]));
      setPhase({ state: "open", result });
      // On a phone the image is the point: scroll it under the thumb.
      if (window.matchMedia(NARROW_LAYOUT_MEDIA).matches) {
        requestAnimationFrame(() => stageRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setPhase({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const onDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      const files = await filesFromDataTransfer(event.dataTransfer);
      if (files.length > 0) void ingest(files);
    },
    [ingest]
  );

  const result = phase.state === "open" ? phase.result : null;
  const study: LocalStudy | null = result?.studies[activeStudy] ?? null;
  const series: LocalSeries | null = study?.series[activeSeries] ?? null;

  const source = useMemo<ViewerSource | null>(() => {
    if (!result || !series) return null;
    const imageIds = seriesImageIds(series, result.imageIdsByFile);
    if (imageIds.length === 0) return null;
    return { kind: "imageIds", key: series.seriesInstanceUID, imageIds };
  }, [result, series]);

  return (
    <div className="flex flex-col gap-4">
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="sr-only"
        // Non-standard but supported in every current browser; it is the only
        // way to pick a whole study folder without the File System Access API.
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) void ingest(files);
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) void ingest(files);
        }}
      />

      {result && source && study && series ? (
        <div className="flex flex-col gap-4 lg:flex-row">
          <Panel className="hidden w-full shrink-0 lg:block lg:w-64" title="Series">
            <div className="flex h-full flex-col gap-3">
              <SeriesList
                result={result}
                study={study}
                activeStudy={activeStudy}
                activeSeries={activeSeries}
                onStudy={(next) => {
                  setActiveStudy(next);
                  setActiveSeries(primarySeriesIndexByProtocol(result.studies[next]));
                }}
                onSeries={pickSeries}
              />
              <div className="mt-auto flex flex-col gap-2 border-t border-subtle pt-3">
                <p className="flex items-start gap-1.5 text-xs text-secondary">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                  These files stay on this computer. Nothing is uploaded.
                </p>
                <Button size="sm" variant="secondary" onClick={() => folderInputRef.current?.click()}>
                  Open another folder
                </Button>
              </div>
            </div>
          </Panel>
          <div
            ref={stageRef}
            data-expanded={expanded ? "true" : undefined}
            className={cn(
              "min-w-0 flex-1 scroll-mt-4",
              expanded && "fixed inset-0 z-40 flex flex-col bg-imaging pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
            )}
          >
            {/* Phone bar: which series, the drawer, fullscreen. Desktop has the side panel. */}
            <div
              className={cn(
                "mb-2 flex items-center gap-2 lg:hidden",
                expanded && "mb-0 bg-black px-2 py-1 text-white lg:flex"
              )}
            >
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setDrawerOpen(true)}
                aria-haspopup="dialog"
                leadingIcon={<Layers className="h-4 w-4" aria-hidden />}
                className={cn("shrink-0 whitespace-nowrap", expanded && "border-white/15 bg-white/10 text-white hover:bg-white/15")}
              >
                Series
                <span className="tabular-nums opacity-70">{formatCount(study.series.length)}</span>
              </Button>
              <span className={cn("min-w-0 flex-1 truncate text-xs", expanded ? "text-white/70" : "text-secondary")}>
                {describeLocalSeries(series)}
              </span>
              <IconButton
                aria-label={expanded ? "Exit fullscreen" : "Fullscreen"}
                title={expanded ? "Exit fullscreen" : "Fullscreen"}
                size="sm"
                onClick={() => void toggleExpanded()}
                className={expanded ? "text-white hover:bg-white/10" : undefined}
              >
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </IconButton>
            </div>
            <div className={cn(expanded && "flex min-h-0 flex-1 flex-col")}>
              <CornerstoneViewer
                key={series.seriesInstanceUID}
                source={source}
                modality={series.modality}
                controls={viewerControls}
                chrome={expanded ? "edge" : "dock"}
                defaultTool="StackScroll"
                questionMarkHelp
              />
            </div>
            {/* Swipe up (or tap) for the series drawer. */}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              onPointerDown={(event) => {
                swipeRef.current = { x: event.clientX, y: event.clientY, t: event.timeStamp };
              }}
              onPointerUp={(event) => {
                const start = swipeRef.current;
                swipeRef.current = null;
                if (start && isSwipeUp(event.clientX - start.x, event.clientY - start.y, event.timeStamp - start.t)) {
                  setDrawerOpen(true);
                }
              }}
              aria-label="Show series"
              className={cn(
                "mt-1 flex w-full touch-none flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] text-muted lg:hidden",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                // Fullscreen keeps every pixel for the image; the bar's Series button opens the drawer.
                expanded && "hidden lg:hidden"
              )}
            >
              <ChevronUp className="h-4 w-4" aria-hidden />
              Swipe up for series
            </button>
            {result.warnings.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {result.warnings.slice(0, 3).map((warning) => (
                  <li key={warning} className="text-xs text-warning">
                    {warning}
                  </li>
                ))}
              </ul>
            )}
            {result.skipped > 0 && (
              <p className="mt-2 text-xs text-secondary tabular-nums">
                {formatCount(result.skipped)} file{result.skipped === 1 ? "" : "s"} in that folder
                were not DICOM images and were skipped.
              </p>
            )}
          </div>
          <Sheet
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            title={study.description?.trim() || "Local study"}
            description={`${formatCount(study.series.length)} series · ${formatCount(study.imageCount)} images`}
          >
            <SeriesList
              result={result}
              study={study}
              activeStudy={activeStudy}
              activeSeries={activeSeries}
              onStudy={(next) => {
                setActiveStudy(next);
                setActiveSeries(primarySeriesIndexByProtocol(result.studies[next]));
              }}
              onSeries={pickSeries}
              hideHeading
            />
            <div className="mt-3 flex flex-col gap-2 border-t border-subtle pt-3">
              <p className="flex items-start gap-1.5 text-xs text-secondary">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                These files stay on this device. Nothing is uploaded.
              </p>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setDrawerOpen(false);
                  fileInputRef.current?.click();
                }}
              >
                Open other files
              </Button>
            </div>
          </Sheet>
        </div>
      ) : (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "rounded-2xl border-2 border-dashed p-6 transition-colors",
            dragging ? "border-accent bg-elevated/60" : "border-subtle"
          )}
        >
          {phase.state === "reading" ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <Spinner label="Reading study" />
              <p className="text-sm text-primary tabular-nums">
                Reading {formatCount(phase.progress.read)} of{" "}
                {formatCount(phase.progress.total)} files
              </p>
              <p className="text-xs text-secondary tabular-nums">
                {formatCount(phase.progress.accepted)} DICOM images found
              </p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  abortRef.current?.abort();
                  setPhase({ state: "idle" });
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <EmptyState
              icon={<HardDrive className="h-6 w-6" aria-hidden />}
              title={
                phase.state === "empty"
                  ? "No DICOM images in that selection"
                  : phase.state === "error"
                    ? "That folder could not be read"
                    : "Open a study from this computer"
              }
              description={
                phase.state === "empty"
                  ? `Inspected ${formatCount(phase.inspected)} files and none were DICOM images. A study CD usually has them under a DICOM/ folder.`
                  : phase.state === "error"
                    ? phase.message
                    : "Drag a study folder here, or pick one. The files are read in this browser — nothing is uploaded, and no account is needed."
              }
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button onClick={() => folderInputRef.current?.click()}>
                    <FolderOpen className="h-4 w-4" aria-hidden />
                    Choose a folder
                  </Button>
                  <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
                    Choose files
                  </Button>
                </div>
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Study picker + series buttons, shared by the desktop panel and the phone drawer. */
function SeriesList({
  result,
  study,
  activeStudy,
  activeSeries,
  onStudy,
  onSeries,
  hideHeading = false,
}: {
  result: LocalOpenResult;
  study: LocalStudy;
  activeStudy: number;
  activeSeries: number;
  onStudy: (index: number) => void;
  onSeries: (index: number) => void;
  hideHeading?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {!hideHeading && (
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium text-primary">{study.description?.trim() || "Local study"}</h2>
          <p className="text-xs text-secondary tabular-nums">
            {formatCount(study.series.length)} series · {formatCount(study.imageCount)} images
            {study.studyDate ? ` · ${study.studyDate}` : ""}
          </p>
        </div>
      )}
      {result.studies.length > 1 && (
        <label className="flex flex-col gap-1 text-xs text-secondary">
          Study
          <select
            value={activeStudy}
            onChange={(event) => onStudy(Number(event.target.value))}
            className="rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm text-primary"
          >
            {result.studies.map((item, index) => (
              <option key={item.studyInstanceUID} value={index}>
                {item.description?.trim() || `Study ${index + 1}`} · {formatCount(item.imageCount)} images
              </option>
            ))}
          </select>
        </label>
      )}
      <ul className="flex flex-col gap-1">
        {study.series.map((item, index) => (
          <li key={item.seriesInstanceUID}>
            <button
              type="button"
              onClick={() => onSeries(index)}
              aria-pressed={index === activeSeries}
              className={cn(
                // 44px rows: a thumb-sized target in the phone drawer.
                "min-h-11 w-full rounded-lg px-2 py-2 text-left text-xs transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                index === activeSeries
                  ? "bg-accent-muted/40 text-primary"
                  : "text-secondary hover:bg-elevated/60 hover:text-primary"
              )}
            >
              <span className="block font-medium tabular-nums">
                {item.seriesNumber != null ? `#${item.seriesNumber} · ` : ""}
                {item.modality || "DICOM"}
              </span>
              <span className="block truncate text-secondary">{describeLocalSeries(item)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Files from a drop, walking directories when the browser exposes them.
 * A folder drop arrives as one entry with no `File`, so without the
 * webkitGetAsEntry walk a dropped study folder reads as zero files.
 */
async function filesFromDataTransfer(transfer: DataTransfer): Promise<File[]> {
  const items = Array.from(transfer.items ?? []);
  const entries = items
    .map((item) =>
      (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null })
        .webkitGetAsEntry?.() ?? null
    )
    .filter((entry): entry is FileSystemEntry => entry != null);

  if (entries.length === 0) return Array.from(transfer.files ?? []);

  const out: File[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null))
      );
      if (file) {
        // Preserve the path so lib/localStudy can group loose files by folder.
        Object.defineProperty(file, "webkitRelativePath", {
          value: prefix ? `${prefix}/${file.name}` : file.name,
          configurable: true,
        });
        out.push(file);
      }
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most 100 per call; keep going until it is empty.
    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) =>
        reader.readEntries(resolve, () => resolve([]))
      );
      if (batch.length === 0) break;
      for (const child of batch) {
        await walk(child, prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  };

  for (const entry of entries) await walk(entry, "");
  return out;
}

export default LocalStudyViewer;
