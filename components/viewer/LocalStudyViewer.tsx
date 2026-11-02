"use client";

// Open a DICOM study from this machine. Nothing is uploaded.
//
// Two homes, one component:
//   • /viewer        — the free, public FlowRad Viewer (tone "reading"): a
//                      full-height dark reading room, no account, no paywall.
//   • /viewer/local  — the same reader inside the RadLearn app shell (tone "page").
//
// Drop or pick a folder, a ZIP, a CD (DICOMDIR) or loose files. The pipeline
// (packages/viewer-core/src/localIngest.ts) parses headers in a Web Worker pool
// and reports the FIRST image as soon as it exists; the viewer paints it while
// the rest parse, then swaps to the ordered stack in place. Pixel bytes are
// read off disk on demand by Cornerstone's decode workers (WASM codecs load only
// for the transfer syntaxes a study uses), the decoded-frame cache is capped per
// device and evicts, and "Close study" frees every frame and file handle.
//
// Privacy contract: no network request carries pixel data or header values,
// nothing from a header is logged, and there is no analytics on this surface.
// e2e/visual/free-viewer.perf.spec.ts enforces it on every PR.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  ChevronUp,
  FileArchive,
  FolderOpen,
  HardDrive,
  Layers,
  Maximize2,
  Minimize2,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { Button, EmptyState, IconButton, Panel, Sheet, Spinner } from "@/components/ui";
import { FilePickerButton } from "@/components/ui/FilePickerButton";
import { cn } from "@/components/ui/cn";
import { seriesImageIds, type LocalOpenProgress } from "@/lib/localDicomFiles";
import { describeLocalSeries, type LocalSeries, type LocalStudy } from "@/lib/localStudy";
import type { ViewerSource } from "@/lib/viewerSource";
import { stackOpenIndex } from "@/lib/stackIndex";
import { primarySeriesIndexByProtocol } from "@flowrad/viewer-core";
import {
  ingestLocalFiles,
  prewarmLocalIngest,
  localMetadataEntryCount,
  releaseLocalImages,
  type FirstLocalImage,
  type LocalIngestResult,
} from "@flowrad/viewer-core/localIngest";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { hapticTick, isSwipeUp } from "@/lib/sheetGesture";
import { NARROW_LAYOUT_MEDIA, requestStageFullscreen } from "@/lib/viewerLayout";

const CornerstoneViewer = dynamic(() => import("@/components/CornerstoneViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-64 w-full items-center justify-center bg-imaging text-white">
      <span className="flex items-center gap-2 text-sm text-white/70">
        <Spinner size="sm" label="Loading viewer" />
        Loading viewer…
      </span>
    </div>
  ),
});

export type LocalViewerTone = "page" | "reading";

/** The paint-first source of a progressive open, kept stable across the swap. */
interface PinnedSource {
  fileName: string;
  modality?: string;
  source: Extract<ViewerSource, { kind: "imageIds" }>;
}

type Phase =
  | { state: "idle" }
  | { state: "reading"; progress: LocalOpenProgress; pinned: PinnedSource | null }
  | { state: "open"; result: LocalIngestResult; pinned: PinnedSource | null }
  | { state: "empty"; inspected: number; warnings: string[] }
  | { state: "error"; message: string };

const SIGNUP_PROMPT_KEY = "flowrad.viewer.signupPrompt.dismissed";
/** Performance marks the perf gate reads (timings only, never identifiers). */
export const FILES_RECEIVED_MARK = "flowrad:viewer:files-received";
export const FIRST_IMAGE_REGISTERED_MARK = "flowrad:viewer:first-image-registered";
export const STUDY_PARSED_MARK = "flowrad:viewer:study-parsed";

function formatCount(n: number): string {
  return n.toLocaleString();
}

function mark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    /* marks are best-effort */
  }
}

function seriesContaining(result: LocalIngestResult, fileName: string): { study: number; series: number } | null {
  for (let s = 0; s < result.studies.length; s += 1) {
    const index = result.studies[s].series.findIndex((series) =>
      series.instances.some((instance) => instance.fileName === fileName)
    );
    if (index >= 0) return { study: s, series: index };
  }
  return null;
}

export interface ViewerMemoryStats {
  cacheBytes: number;
  maxCacheBytes: number;
  openFiles: number;
  /** Local images still holding a NATURALIZED metadata entry (raw file bytes). */
  metadataEntries: number;
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<FileSystemDirectoryHandle>;
};

export function LocalStudyViewer({ tone = "page" }: { tone?: LocalViewerTone }) {
  const reading = tone === "reading";
  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const [activeStudy, setActiveStudy] = useState(0);
  const [activeSeries, setActiveSeries] = useState(0);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** Every registered `dicomfile:` id of the open study — freed on close. */
  const registeredRef = useRef<string[]>([]);
  const folderInputId = useId();
  const fileInputId = useId();
  /** Phones: the series list is a bottom drawer, and the stage can go fullscreen. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const swipeRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const viewerControls = useRef<CornerstoneControls | null>(null);
  /**
   * Chromium's `<input webkitdirectory>` asks "Upload N files to this site?" —
   * the opposite of what this page promises. Where the File System Access
   * picker exists, the public viewer uses it instead (read-only, no prompt).
   * Before hydration, and on Safari/Firefox, the <label for> input remains.
   */
  const [nativeFolderPicker, setNativeFolderPicker] = useState(false);
  const [signupDismissed, setSignupDismissed] = useState(true);

  useEffect(() => {
    if (reading && typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function") {
      setNativeFolderPicker(true);
    }
    try {
      setSignupDismissed(window.localStorage.getItem(SIGNUP_PROMPT_KEY) === "1");
    } catch {
      setSignupDismissed(false);
    }
    // Warm the parser, the header workers and the file manager while the
    // user is still choosing: the first drop then pays none of that.
    const idle =
      (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
        .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1));
    idle(
      () => {
        prewarmLocalIngest();
        // The viewer component and an initialised engine (decode workers
        // booted, codecs registered) — ~0.4 s off the first image.
        void import("@/components/CornerstoneViewer")
          .then((module) => module.prewarmViewerEngine())
          .catch(() => undefined);
      },
      { timeout: 500 }
    );
  }, [reading]);

  // Numbers only, for the perf gate and support: how much decoded imaging the
  // tab holds against its cap. Never an identifier or a pixel.
  useEffect(() => {
    const w = window as Window & { __flowradViewerStats?: () => Promise<ViewerMemoryStats> };
    w.__flowradViewerStats = async () => {
      const core = await import("@cornerstonejs/core");
      return {
        cacheBytes: core.cache.getCacheSize(),
        maxCacheBytes: core.cache.getMaxCacheSize(),
        openFiles: registeredRef.current.length,
        metadataEntries: await localMetadataEntryCount(),
      };
    };
    return () => {
      delete w.__flowradViewerStats;
    };
  }, []);

  const release = useCallback(() => {
    const ids = registeredRef.current;
    registeredRef.current = [];
    if (ids.length === 0) return;
    // Freed back to the page's pre-open footprint, then re-warmed (fresh,
    // empty header workers) so the next drop is as fast as the first.
    void releaseLocalImages(ids)
      .then(() => prewarmLocalIngest())
      .catch(() => undefined);
  }, []);

  // Leaving the page frees the study (SPA navigation away included).
  useEffect(
    () => () => {
      abortRef.current?.abort();
      release();
    },
    [release]
  );

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

  // The stage changes shape: fit the image to it once the layout settles.
  useEffect(() => {
    const t = window.setTimeout(() => viewerControls.current?.fit?.(), 250);
    return () => window.clearTimeout(t);
  }, [expanded]);

  const pickSeries = useCallback((index: number) => {
    setActiveSeries(index);
    setDrawerOpen(false);
    hapticTick();
  }, []);

  const closeStudy = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setDrawerOpen(false);
    setExpanded(false);
    setPhase({ state: "idle" });
    release();
  }, [release]);

  const ingest = useCallback(
    async (files: File[]) => {
      mark(FILES_RECEIVED_MARK);
      abortRef.current?.abort();
      release();
      const controller = new AbortController();
      abortRef.current = controller;
      setActiveStudy(0);
      setActiveSeries(0);
      setPhase({ state: "reading", progress: { read: 0, accepted: 0, total: files.length }, pinned: null });

      // The full stack for the first image's series, resolved when parsing ends.
      let resolveFull: (value: { imageIds: string[]; openIndex: number }) => void = () => {};
      let rejectFull: (reason: Error) => void = () => {};
      const full = new Promise<{ imageIds: string[]; openIndex: number }>((resolve, reject) => {
        resolveFull = resolve;
        rejectFull = reject;
      });
      void full.catch(() => undefined);
      let pinned: PinnedSource | null = null;

      const onFirstImage = (first: FirstLocalImage) => {
        if (controller.signal.aborted) return;
        mark(FIRST_IMAGE_REGISTERED_MARK);
        pinned = {
          fileName: first.fileName,
          modality: first.header.modality,
          source: { kind: "imageIds", key: `local:${first.imageIds[0]}`, imageIds: first.imageIds, full },
        };
        const current = pinned;
        setPhase((prev) =>
          prev.state === "reading" ? { ...prev, pinned: current } : prev
        );
        // On a phone the image is the point: scroll it under the thumb.
        if (!reading && window.matchMedia(NARROW_LAYOUT_MEDIA).matches) {
          requestAnimationFrame(() => stageRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
        }
      };

      try {
        const result = await ingestLocalFiles(files, {
          signal: controller.signal,
          onFirstImage,
          onProgress: (progress) =>
            setPhase((prev) => (prev.state === "reading" ? { ...prev, progress } : prev)),
        });
        registeredRef.current = result.registeredIds;
        if (controller.signal.aborted) {
          release();
          rejectFull(new Error("aborted"));
          return;
        }
        mark(STUDY_PARSED_MARK);
        if (result.studies.length === 0) {
          rejectFull(new Error("empty"));
          setPhase({ state: "empty", inspected: files.length, warnings: result.warnings });
          return;
        }
        const pinnedNow = pinned as PinnedSource | null;
        const located = pinnedNow ? seriesContaining(result, pinnedNow.fileName) : null;
        if (pinnedNow && located) {
          const series = result.studies[located.study].series[located.series];
          const ids = seriesImageIds(series, result.imageIdsByFile);
          // Open where every stack opens (the middle slice). The preview was
          // chosen to usually be that slice already (localIngest.ts).
          resolveFull({ imageIds: ids, openIndex: stackOpenIndex(ids.length) });
          setActiveStudy(located.study);
          setActiveSeries(located.series);
        } else {
          rejectFull(new Error("first image not in a series"));
          // Open on the series a hanging protocol would read first.
          setActiveSeries(primarySeriesIndexByProtocol(result.studies[0]));
        }
        setPhase({ state: "open", result, pinned: located ? pinnedNow : null });
      } catch (error) {
        rejectFull(new Error("failed"));
        if (controller.signal.aborted) return;
        release();
        setPhase({
          state: "error",
          message: error instanceof Error ? error.message : "The files could not be read.",
        });
      }
    },
    [reading, release]
  );

  const pickFolderNative = useCallback(async () => {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) return;
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await picker({ mode: "read" });
    } catch {
      return; // cancelled
    }
    const files = await filesFromDirectoryHandle(handle);
    if (files.length > 0) void ingest(files);
    else setPhase({ state: "empty", inspected: 0, warnings: [] });
  }, [ingest]);

  const onDrop = useCallback(
    async (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      setDragging(false);
      const files = await filesFromDataTransfer(event.dataTransfer);
      if (files.length > 0) void ingest(files);
    },
    [ingest]
  );

  const dismissSignup = useCallback(() => {
    setSignupDismissed(true);
    try {
      window.localStorage.setItem(SIGNUP_PROMPT_KEY, "1");
    } catch {
      /* private mode: dismissed for this visit only */
    }
  }, []);

  const result = phase.state === "open" ? phase.result : null;
  const pinned = phase.state === "open" || phase.state === "reading" ? phase.pinned : null;
  const study: LocalStudy | null = result?.studies[activeStudy] ?? null;
  const series: LocalSeries | null = study?.series[activeSeries] ?? null;
  const pinnedIsActive =
    !!pinned && (phase.state === "reading" || !!series?.instances.some((i) => i.fileName === pinned.fileName));

  const source = useMemo<ViewerSource | null>(() => {
    // The paint-first source stays the SAME object through the swap so the
    // engine is not remounted; only another series builds a new source.
    if (pinned && pinnedIsActive) return pinned.source;
    if (!result || !series) return null;
    const imageIds = seriesImageIds(series, result.imageIdsByFile);
    if (imageIds.length === 0) return null;
    return { kind: "imageIds", key: series.seriesInstanceUID, imageIds };
  }, [pinned, pinnedIsActive, result, series]);

  const viewerKey = source?.kind === "imageIds" ? source.key : "none";
  const modality = series?.modality ?? pinned?.modality;
  const showStage = !!source && (phase.state === "open" || phase.state === "reading");

  const folderButton = nativeFolderPicker ? (
    <Button
            onClick={() => void pickFolderNative()}
      leadingIcon={<FolderOpen aria-hidden />}
    >
      Choose a folder
    </Button>
  ) : (
    <FilePickerButton inputId={folderInputId} leadingIcon={<FolderOpen aria-hidden />}>
      Choose a folder
    </FilePickerButton>
  );

  const privacyLine = (
    <p
      className={cn(
        "flex items-start gap-1.5 text-xs",
        reading ? "text-white/70" : "text-secondary"
      )}
    >
      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
      Your images never leave your computer.
    </p>
  );

  const sidePanel = (
    <div className="flex h-full flex-col gap-3">
      {result && study ? (
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
          dark={reading}
        />
      ) : phase.state === "reading" ? (
        <ReadingProgress progress={phase.progress} dark={reading} />
      ) : null}
      <div className={cn("mt-auto flex flex-col gap-2 border-t pt-3", reading ? "border-white/10" : "border-subtle")}>
        {result && !signupDismissed && <SignupPrompt dark={reading} onDismiss={dismissSignup} />}
        {privacyLine}
        <div className="flex flex-wrap gap-2">
          <FilePickerButton inputId={fileInputId} size="sm" variant={reading ? "imaging" : "secondary"}>
            Open other files
          </FilePickerButton>
          <Button size="sm" variant={reading ? "imaging" : "ghost"} onClick={closeStudy}>
            Close study
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className={cn("flex flex-col gap-4", reading && "h-full min-h-0")}>
      <input
        id={folderInputId}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        // Non-standard but supported in every current browser; the folder
        // picker for Safari and Firefox, and for Chromium before hydration.
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) void ingest(files);
        }}
      />
      <input
        id={fileInputId}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) void ingest(files);
        }}
      />

      {showStage && source ? (
        <div
          className={cn("flex flex-col gap-4 lg:flex-row", reading && "min-h-0 flex-1 gap-0 lg:gap-0")}
          onDragOver={(event) => {
            if (!reading) return;
            event.preventDefault();
          }}
          onDrop={reading ? onDrop : undefined}
        >
          {reading ? (
            <aside
              aria-label="Series"
              className="hidden w-72 shrink-0 flex-col overflow-y-auto border-r border-white/10 bg-imaging p-3 lg:flex"
            >
              {sidePanel}
            </aside>
          ) : (
            <Panel className="hidden w-full shrink-0 lg:block lg:w-64" title="Series">
              {sidePanel}
            </Panel>
          )}
          <div
            ref={stageRef}
            data-expanded={expanded ? "true" : undefined}
            data-testid="local-stage"
            className={cn(
              "min-w-0 flex-1 scroll-mt-4",
              reading && "flex min-h-0 flex-col bg-imaging",
              expanded && "fixed inset-0 z-40 flex flex-col bg-imaging pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
            )}
          >
            {/* Phone bar: which series, the drawer, fullscreen. Desktop has the side panel. */}
            <div
              className={cn(
                "mb-2 flex items-center gap-2 lg:hidden",
                (expanded || reading) && "mb-0 bg-imaging px-2 py-1 text-white",
                expanded && "lg:flex"
              )}
            >
              <Button
                size="sm"
                variant={expanded || reading ? "imaging" : "secondary"}
                onClick={() => setDrawerOpen(true)}
                aria-haspopup="dialog"
                leadingIcon={<Layers className="h-4 w-4" aria-hidden />}
                className="shrink-0 whitespace-nowrap"
              >
                Series
                {study && <span className="tabular-nums opacity-70">{formatCount(study.series.length)}</span>}
              </Button>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs tabular-nums",
                  expanded || reading ? "text-white/70" : "text-secondary"
                )}
              >
                {series
                  ? describeLocalSeries(series)
                  : phase.state === "reading"
                    ? `Reading ${formatCount(phase.progress.read)} of ${formatCount(phase.progress.total)} files…`
                    : ""}
              </span>
              <IconButton
                aria-label={expanded ? "Exit fullscreen" : "Fullscreen"}
                title={expanded ? "Exit fullscreen" : "Fullscreen"}
                size="sm"
                onClick={() => void toggleExpanded()}
                className={expanded || reading ? "text-white hover:bg-white/10" : undefined}
              >
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </IconButton>
            </div>
            <div className={cn((expanded || reading) && "flex min-h-0 flex-1 flex-col")}>
              <CornerstoneViewer
                key={viewerKey}
                source={source}
                modality={modality}
                controls={viewerControls}
                chrome={expanded || reading ? "edge" : "dock"}
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
                // Fullscreen and the reading room keep every pixel for the image.
                (expanded || reading) && "hidden lg:hidden"
              )}
            >
              <ChevronUp className="h-4 w-4" aria-hidden />
              Swipe up for series
            </button>
            {result && (result.warnings.length > 0 || result.skipped > 0) && (
              <div className={cn("flex flex-col gap-1", reading ? "px-3 py-2" : "mt-2")}>
                {result.warnings.slice(0, 3).map((warning) => (
                  <p key={warning} className="text-xs text-warning">
                    {warning}
                  </p>
                ))}
                {result.skipped > 0 && (
                  <p className={cn("text-xs tabular-nums", reading ? "text-white/60" : "text-secondary")}>
                    {formatCount(result.skipped)} file{result.skipped === 1 ? "" : "s"} were not DICOM
                    images and were skipped.
                  </p>
                )}
              </div>
            )}
          </div>
          <Sheet
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            title={study?.description?.trim() || "Local study"}
            description={
              study
                ? `${formatCount(study.series.length)} series · ${formatCount(study.imageCount)} images`
                : "Reading the study…"
            }
          >
            {result && study ? (
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
            ) : phase.state === "reading" ? (
              <ReadingProgress progress={phase.progress} />
            ) : null}
            <div className="mt-3 flex flex-col gap-2 border-t border-subtle pt-3">
              {result && !signupDismissed && <SignupPrompt onDismiss={dismissSignup} />}
              <p className="flex items-start gap-1.5 text-xs text-secondary">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                Your images never leave your computer.
              </p>
              <div className="flex flex-wrap gap-2">
                <FilePickerButton inputId={fileInputId} size="sm" variant="secondary" onClick={() => setDrawerOpen(false)}>
                  Open other files
                </FilePickerButton>
                <Button size="sm" variant="ghost" onClick={closeStudy}>
                  Close study
                </Button>
              </div>
            </div>
          </Sheet>
        </div>
      ) : (
        <div
          data-testid="local-dropzone"
          role="region"
          aria-label="Drop a study folder, ZIP or files here"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "rounded-2xl border-2 border-dashed p-6 transition-colors",
            reading && "mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center sm:my-8",
            dragging
              ? "border-accent bg-elevated/60"
              : reading
                ? "border-white/15 bg-white/[0.02]"
                : "border-subtle"
          )}
        >
          {phase.state === "reading" ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <Spinner label="Reading study" />
              <ReadingProgress progress={phase.progress} dark={reading} centered />
              <Button
                size="sm"
                variant={reading ? "imaging" : "ghost"}
                onClick={closeStudy}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <EmptyState
              tone={reading ? "imaging" : "default"}
              icon={<HardDrive className="h-6 w-6" aria-hidden />}
              title={
                phase.state === "empty"
                  ? "No DICOM images in that selection"
                  : phase.state === "error"
                    ? "That study could not be read"
                    : reading
                      ? "Drop a study to view it"
                      : "Open a study from this computer"
              }
              description={
                phase.state === "empty"
                  ? phase.warnings[0] ??
                    `Inspected ${formatCount(phase.inspected)} files and none were DICOM images. A study CD usually has them under a DICOM/ folder.`
                  : phase.state === "error"
                    ? phase.message
                    : "A folder, a ZIP, a CD or loose DICOM files. They are read in this browser — nothing is uploaded, and no account is needed."
              }
              action={
                <div className="flex flex-col items-center gap-3">
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {folderButton}
                    <FilePickerButton
                      inputId={fileInputId}
                      variant={reading ? "imaging" : "secondary"}
                      leadingIcon={<FileArchive aria-hidden />}
                    >
                      Choose files
                    </FilePickerButton>
                  </div>
                  {privacyLine}
                </div>
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

function ReadingProgress({
  progress,
  dark = false,
  centered = false,
}: {
  progress: LocalOpenProgress;
  dark?: boolean;
  centered?: boolean;
}) {
  const pct = progress.total > 0 ? Math.min(100, Math.round((progress.read / progress.total) * 100)) : 0;
  return (
    <div className={cn("flex w-full max-w-xs flex-col gap-2", centered && "items-center text-center")} aria-live="polite">
      <p className={cn("text-sm tabular-nums", dark ? "text-white" : "text-primary")}>
        Reading {formatCount(progress.read)} of {formatCount(progress.total)} files
      </p>
      <div
        className={cn("h-1 w-full overflow-hidden rounded-full", dark ? "bg-white/10" : "bg-elevated")}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Reading study"
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
      </div>
      <p className={cn("text-xs tabular-nums", dark ? "text-white/60" : "text-secondary")}>
        {formatCount(progress.accepted)} DICOM images found
      </p>
    </div>
  );
}

/** Soft, dismissible: viewing is free forever; an account is only for keeping things. */
function SignupPrompt({ onDismiss, dark = false }: { onDismiss: () => void; dark?: boolean }) {
  return (
    <div
      className={cn(
        "relative rounded-lg border p-3 pr-8",
        dark ? "border-white/10 bg-white/[0.04]" : "border-subtle bg-elevated"
      )}
    >
      <p className={cn("flex items-center gap-1.5 text-xs font-semibold", dark ? "text-white" : "text-primary")}>
        <Sparkles className="h-3.5 w-3.5 text-accent" aria-hidden />
        Keep this study?
      </p>
      <p className={cn("mt-1 text-xs", dark ? "text-white/70" : "text-secondary")}>
        A free account lets you save, share, teach with it, ask the AI tutor and compare priors.
        Viewing stays free without one.
      </p>
      <Link
        href="/sign-up?next=/viewer"
        // No prefetch: after a drop this page makes no request it does not need.
        prefetch={false}
        className="mt-2 inline-block rounded text-xs font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Create a free account
      </Link>
      <IconButton
        aria-label="Dismiss"
        size="sm"
        onClick={onDismiss}
        className={cn("absolute right-1 top-1", dark && "text-white/70 hover:bg-white/10")}
      >
        <X />
      </IconButton>
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
  dark = false,
}: {
  result: LocalIngestResult;
  study: LocalStudy;
  activeStudy: number;
  activeSeries: number;
  onStudy: (index: number) => void;
  onSeries: (index: number) => void;
  hideHeading?: boolean;
  dark?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {!hideHeading && (
        <div className="flex flex-col gap-1">
          <h2 className={cn("text-sm font-medium", dark ? "text-white" : "text-primary")}>
            {study.description?.trim() || "Local study"}
          </h2>
          <p className={cn("text-xs tabular-nums", dark ? "text-white/60" : "text-secondary")}>
            {formatCount(study.series.length)} series · {formatCount(study.imageCount)} images
            {study.studyDate ? ` · ${study.studyDate}` : ""}
          </p>
        </div>
      )}
      {result.studies.length > 1 && (
        <label className={cn("flex flex-col gap-1 text-xs", dark ? "text-white/60" : "text-secondary")}>
          Study
          <select
            value={activeStudy}
            onChange={(event) => onStudy(Number(event.target.value))}
            className={cn(
              "rounded-lg border px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              dark ? "border-white/15 bg-imaging text-white" : "border-subtle bg-surface text-primary"
            )}
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
                dark
                  ? index === activeSeries
                    ? "bg-white/[0.12] text-white"
                    : "text-white/70 hover:bg-white/[0.06] hover:text-white"
                  : index === activeSeries
                    ? "bg-accent-muted/40 text-primary"
                    : "text-secondary hover:bg-elevated/60 hover:text-primary"
              )}
            >
              <span className="block font-medium tabular-nums">
                {item.seriesNumber != null ? `#${item.seriesNumber} · ` : ""}
                {item.modality || "DICOM"}
              </span>
              <span className={cn("block truncate", dark ? "text-white/60" : "text-secondary")}>
                {describeLocalSeries(item)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function withRelativePath(file: File, path: string): File {
  // Preserve the path so lib/localStudy can group loose files by folder.
  Object.defineProperty(file, "webkitRelativePath", { value: path, configurable: true });
  return file;
}

/** Every file under a File System Access directory handle, with its path. */
async function filesFromDirectoryHandle(root: FileSystemDirectoryHandle): Promise<File[]> {
  const out: File[] = [];
  type Iterable = FileSystemDirectoryHandle & {
    values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>;
  };
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    const pending: Promise<void>[] = [];
    for await (const handle of (dir as Iterable).values()) {
      const path = `${prefix}/${handle.name}`;
      if (handle.kind === "file") {
        pending.push(
          (handle as FileSystemFileHandle)
            .getFile()
            .then((file) => {
              out.push(withRelativePath(file, path));
            })
            .catch(() => undefined)
        );
      } else {
        pending.push(walk(handle as FileSystemDirectoryHandle, path));
      }
    }
    await Promise.all(pending);
  };
  await walk(root, root.name);
  return out;
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
      if (file) out.push(withRelativePath(file, prefix ? `${prefix}/${file.name}` : file.name));
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    // readEntries returns at most 100 per call; keep going until it is empty.
    const pending: Promise<void>[] = [];
    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) =>
        reader.readEntries(resolve, () => resolve([]))
      );
      if (batch.length === 0) break;
      for (const child of batch) pending.push(walk(child, childPrefix));
    }
    await Promise.all(pending);
  };

  await Promise.all(entries.map((entry) => walk(entry, "")));
  return out;
}

export default LocalStudyViewer;
