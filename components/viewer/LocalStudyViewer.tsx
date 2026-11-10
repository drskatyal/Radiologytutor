"use client";

// Open a DICOM study from this machine. Nothing is uploaded.
//
// Two homes, one component:
//   • /viewer        — the free, public FlowRad Viewer (tone "reading"): a
//                      full-height dark reading room, no account, no paywall.
//   • /viewer/local  — the same reading room inside FlowRad Learn (ViewerShell).
//   tone "page" (the reader inside an app page) remains for other callers.
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

import { FREE_VIEWER_FEATURES } from "@/lib/viewerFeatures";
import { useViewerBindings } from "./useViewerBindings";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  ChevronUp,
  ExternalLink,
  FileArchive,
  FileText,
  FolderOpen,
  HardDrive,
  Columns2,
  Layers,
  LayoutGrid,
  Link2,
  List,
  Maximize2,
  Minimize2,
  ShieldCheck,
  Sparkles,
  Unlink,
  X,
} from "lucide-react";
import { usePopOutWindows } from "@/components/viewer/usePopOutWindows";
import { useMultipleScreens } from "@/components/viewer/useMultipleScreens";
import { Button, CollapsiblePanel, EmptyState, IconButton, Panel, Sheet, Spinner, Tooltip } from "@/components/ui";
import { useSeriesPanel } from "@/components/viewer/useSeriesPanel";
import { isSeriesPanelShortcut, layoutForShortcut, layoutsForSeriesCount, layoutWithMorePanes, nextLayout, paneCount, READING_LAYOUTS, type HangingLayoutId, type MenuCommand } from "@flowrad/viewer-core";
import { flattenSeries, hangLocal, layoutById, layoutForGrid, samePane, type PaneSeries } from "@/lib/localHanging";
import { linkedIndex, planeSign, sameCamera, sameModality, sameWindow, seriesGeometry } from "@/lib/paneScrollLink";
import type { ViewerEvent } from "@/lib/types";
import type { RemotePlane } from "@/components/viewer/RemoteReferenceLines";
import { monitorColor } from "@flowrad/viewer-core";
import { FilePickerButton } from "@/components/ui/FilePickerButton";
import { cn } from "@/components/ui/cn";
import { seriesImageIds, type LocalOpenProgress } from "@/lib/localDicomFiles";
import { describeLocalSeries, type LocalSeries, type LocalStudy } from "@/lib/localStudy";
import { localSeriesSummary } from "@flowrad/viewer-core/localStudy";
import { isFullScreenKey, isPopOutKey, openKeyOf } from "@flowrad/viewer-core/readingKeys";
import { pickFusionPair } from "@flowrad/viewer-core/petFusion";
import { StructuredReportDialog } from "@/components/viewer/StructuredReportDialog";
import { ViewerLanding, type LandingStatus } from "@/components/viewer/ViewerLanding";
import { useWebFolderWatcher, WatchFoldersEntry } from "@/components/viewer/WebWatchFolders";
import type { ViewerSource } from "@/lib/viewerSource";
import { stackOpenIndex } from "@/lib/stackIndex";
import {
  isKeyImageSeries,
  localComparePlan,
  primarySeriesIndexByProtocol,
  reportsForStudy,
  stopParkedVoice,
  thumbnailImageId,
  type DicomDocument,
} from "@flowrad/viewer-core";
import { createLocalThumbnailer, type LocalThumbnailer } from "@flowrad/viewer-core/localThumbnails";
import { LocalSeriesThumb } from "@/components/viewer/LocalSeriesThumb";
import {
  ingestLocalFiles,
  prewarmLocalIngest,
  applyLocalCacheBudget,
  localMetadataEntryCount,
  localRawBytesHeld,
  releaseLocalImages,
  localSeriesFiles,
  type FirstLocalImage,
  type LocalIngestResult,
} from "@flowrad/viewer-core/localIngest";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { ExportDicomFiles } from "@/components/viewer/WebExportDialog";
import { hapticTick, isSwipeUp } from "@/lib/sheetGesture";
import { EDGE_TOOLBAR_PX, NARROW_LAYOUT_MEDIA, READING_SERIES_ASIDE_PX, requestStageFullscreen } from "@/lib/viewerLayout";
import {
  importWithRetry,
  isChunkLoadError,
  mayReloadForChunkError,
  reloadForChunkError,
  takeSavedPlace,
} from "@/lib/chunkRecovery";
import {
  clearStudyHandles,
  recallStudyHandles,
  regainStudyHandles,
  rememberStudyHandles,
  studyHandlesReadable,
} from "@/lib/studyHandleStore";
import { clearRecentStudies, forgetRecentStudy, KEPT_STUDIES_CLEARED_EVENT, listRecentStudies, recentStudyHandles, recentStudySalt, rememberRecentStudy, setRecentStudyKept } from "@/lib/recentStudyStore";
import { formatBytes, keepStudy, KeepStudyError, keptStudyFiles, forgetKeptStudy, studyLibrarySupported } from "@/lib/studyLibrary";
import { priorsAmong, recentStudyEntry, type RecentStudy } from "@flowrad/viewer-core/recentStudies";
import { SCALE_BAR_STORAGE_KEY } from "@flowrad/viewer-core/scaleBar";
import { loadScrollPreferences } from "@/lib/scrollPreferencesStore";
import { getRecentStudiesEnabled, setRecentStudiesEnabled, useRecentStudiesEnabled } from "@/lib/recentStudiesSetting";
import { readSeriesListCompact, writeSeriesListCompact } from "@flowrad/viewer-core/seriesPanel";
import { RecentStudies } from "./RecentStudies";

/** Raised when the viewer's own code could not be fetched (after retries). */
const VIEWER_CHUNK_ERROR_EVENT = "flowrad:viewer-chunk-error";
/** How long "Updating viewer, reloading…" shows before the recovery reload. */
const RECOVERY_NOTICE_MS = 1500;

/** Stands in for the viewer when its code could not be fetched: calm, not an error. */
function ViewerCodeUnavailable() {
  return <UpdatingNotice />;
}

/** The Watched folders dialog, on first open (Chrome / Edge only). */
const WebWatchFoldersDialog = dynamic(
  () => importWithRetry(() => import("@/components/viewer/WebWatchFoldersDialog")).then((m) => m.WebWatchFoldersDialog),
  { ssr: false }
);

/** A series' info (its tags), from a thumbnail's menu: loaded on first use. */
const DicomTagsDialog = dynamic(
  () => importWithRetry(() => import("@/components/viewer/DicomTagsDialog")).then((m) => m.DicomTagsDialog),
  { ssr: false }
);

/** A series thumbnail's right-click menu, on the first right-click. */
const SeriesThumbMenu = dynamic(
  () => importWithRetry(() => import("@/components/viewer/SeriesThumbMenu")).then((m) => m.SeriesThumbMenu),
  { ssr: false }
);

/** PET / CT fusion over the stage, on first open. */
const WebFusionOverlay = dynamic(
  () => importWithRetry(() => import("@/components/viewer/fusion/WebFusionOverlay")).then((m) => m.WebFusionOverlay),
  { ssr: false }
);

const CornerstoneViewer = dynamic(
  () =>
    importWithRetry(() => import("@/components/CornerstoneViewer")).catch((error: unknown) => {
      if (!isChunkLoadError(error)) throw error;
      window.dispatchEvent(new CustomEvent(VIEWER_CHUNK_ERROR_EVENT));
      return ViewerCodeUnavailable as unknown as typeof import("@/components/CornerstoneViewer").default;
    }),
  {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-64 w-full items-center justify-center bg-imaging text-white">
      <span className="flex items-center gap-2 text-sm text-white/70">
        <Spinner size="sm" label="Loading viewer" />
        Loading viewer…
      </span>
    </div>
  ),
  }
);

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
/** De-identified 10-frame MR bundled with the app (public/dicom). */
const SAMPLE_STUDY_URL = "/dicom/teach_anon_mr.dcm";
/** Performance marks the perf gate reads (timings only, never identifiers). */
export const FILES_RECEIVED_MARK = "flowrad:viewer:files-received";
export const FIRST_IMAGE_REGISTERED_MARK = "flowrad:viewer:first-image-registered";
export const STUDY_PARSED_MARK = "flowrad:viewer:study-parsed";
export const FIRST_IMAGE_DECODED_MARK = "flowrad:viewer:first-image-decoded";

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
    // Key-image series only borrow instances: the slice belongs to its real series.
    const index = result.studies[s].series.findIndex(
      (series) =>
        !isKeyImageSeries(series) && series.instances.some((instance) => instance.fileName === fileName)
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
  /** Raw Part 10 bytes the loader holds beside the decoded cache. */
  rawBytes: number;
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<FileSystemDirectoryHandle>;
};

export function LocalStudyViewer({ tone = "page" }: { tone?: LocalViewerTone }) {
  // Mouse & keyboard bindings: the local copy, and the signed-in copy fetched
  // now — before any study is opened (no request may follow a drop).
  useViewerBindings({ account: true });
  const reading = tone === "reading";
  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  // Series panel (reading room): collapsible to a rail, remembered per device.
  const seriesPanel = useSeriesPanel();
  const [modKey, setModKey] = useState("Ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setModKey("⌘");
  }, []);
  /** The first image of the open study is on screen (thumbnails may start). */
  const [firstImageUp, setFirstImageUp] = useState(false);
  const [activeStudy, setActiveStudy] = useState(0);
  const [activeSeries, setActiveSeries] = useState(0);
  // Hanging layout (the desktop's seven: 1 up to 3×3). Pane 0 is the main
  // viewer (activeStudy / activeSeries, the paint-first pipeline); panes 1–8
  // each show their own series, from any study of the drop. One toolbar
  // under the grid follows the focused pane.
  const [layoutId, setLayoutId] = useState<HangingLayoutId>("1x1");
  /** The pane filling the grid (double-click or Enter; Esc restores), or null. */
  const [maximized, setMaximized] = useState<number | null>(null);
  const [extraPanes, setExtraPanes] = useState<PaneSeries[]>([]);
  // Current vs prior, as on the desktop: what the protocol hung, for its label.
  const [comparison, setComparison] = useState<{ current: PaneSeries; prior: PaneSeries; label: string } | null>(null);
  /** The prior's registration (mm) until both panes are up to apply it. */
  const compareOffset = useRef<number | null>(null);
  const [activePane, setActivePane] = useState(0);
  const activePaneRef = useRef(0);
  activePaneRef.current = activePane;
  const multiRef = useRef(false);
  const [barHost, setBarHost] = useState<HTMLDivElement | null>(null);
  // One controls ref per extra pane of the largest grid (3×3).
  const paneControls = useRef<MutableRefObject<CornerstoneControls | null>[]>(
    Array.from({ length: 8 }, () => ({ current: null }))
  );
  // Voice commands stay on across series (each series mounts its own viewer,
  // which hands the live microphone session to the next: voiceHandoff.ts).
  const [voiceOn, setVoiceOn] = useState(false);
  // Leaving the viewer: a session parked mid-handoff must not keep the mic.
  // After a tick, so the unmounting viewer has parked it first.
  useEffect(() => () => void setTimeout(stopParkedVoice, 0), []);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** Every registered `dicomfile:` id of the open study — freed on close. */
  const registeredRef = useRef<string[]>([]);
  const folderInputId = useId();
  const fileInputId = useId();
  /** Phones: the series list is a bottom drawer, and the stage can go fullscreen. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  /** Distraction-free reading (free viewer, as on the desktop): the images only. */
  const [focusMode, setFocusMode] = useState(false);
  /** Its "how to leave" hint, shown for a moment after it starts. */
  const [focusHint, setFocusHint] = useState(false);
  /** The structured report being read (dialog), if any. */
  const [openReport, setOpenReport] = useState<DicomDocument | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const swipeRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const viewerControls = useRef<CornerstoneControls | null>(null);
  /** The files opened here, handed to popped-out windows. */
  const [openedFiles, setOpenedFiles] = useState<File[] | null>(null);
  /** Pop-out: the series to show once its files are read. */
  const wantSeries = useRef<string | null>(null);
  // Recovery from a new build arriving under an open tab (lib/chunkRecovery):
  // "updating" while it reloads, "failed" when a reload already happened.
  const [recovery, setRecovery] = useState<"updating" | "failed" | null>(null);
  // After that reload: the study's handles (Chromium) and where the reader was.
  const [restore, setRestore] = useState<{ handles: FileSystemHandle[]; place?: Record<string, number> } | null>(null);
  const restorePlace = useRef<Record<string, number> | null>(null);
  const pendingSlice = useRef<number | null>(null);
  // Handles of the study being opened (folder picker / drop), kept on open.
  const openingHandles = useRef<FileSystemHandle[]>([]);
  // "Compare with prior…", as on the desktop: this patient's newest earlier
  // study among the recent studies, offered while one study opened from a
  // folder / file handle is up. Reopens both together (the compare hanging).
  const [priorOffer, setPriorOffer] = useState<{ handles: FileSystemHandle[]; prior: RecentStudy } | null>(null);
  const [priorNotice, setPriorNotice] = useState<string | null>(null);
  const [priorOpening, setPriorOpening] = useState(false);
  const openGeneration = useRef(0);
  // The study library (the desktop's archive): this open study's recent-list
  // key, and whether a copy of its files is kept in this browser.
  const [library, setLibrary] = useState<{ key: string; keptBytes?: number } | null>(null);
  const [keeping, setKeeping] = useState<{ done: number; total: number } | null>(null);
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
  const [librarySupported, setLibrarySupported] = useState(false);
  useEffect(() => {
    if (reading) void studyLibrarySupported().then(setLibrarySupported);
  }, [reading]);
  // Help › Customise › Remove all: the open study is no longer kept.
  useEffect(() => {
    const onCleared = () => setLibrary((cur) => (cur ? { key: cur.key } : cur));
    window.addEventListener(KEPT_STUDIES_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(KEPT_STUDIES_CLEARED_EVENT, onCleared);
  }, []);
  // Recent studies (Chromium): what was opened from a folder handle, newest first.
  const [recent, setRecent] = useState<RecentStudy[]>([]);
  const [recentOpening, setRecentOpening] = useState<string | null>(null);
  const [recentNotice, setRecentNotice] = useState<string | null>(null);
  const [popOutNote, setPopOutNote] = useState<string | null>(null);
  /**
   * Chromium's `<input webkitdirectory>` asks "Upload N files to this site?" —
   * the opposite of what this page promises. Where the File System Access
   * picker exists, the public viewer uses it instead (read-only, no prompt).
   * Before hydration, and on Safari/Firefox, the <label for> input remains.
   */
  const [nativeFolderPicker, setNativeFolderPicker] = useState(false);
  const [signupDismissed, setSignupDismissed] = useState(true);
  // Watched folders (Chrome / Edge only; opt-in, read-only, while this tab is open).
  const folderWatch = useWebFolderWatcher();
  const [watchOpen, setWatchOpen] = useState(false);
  const openWatch = useCallback(() => {
    folderWatch.seen();
    setWatchOpen(true);
  }, [folderWatch]);

  /**
   * Where the first study's image will draw, from the reading-room layout:
   * the page's viewer area (the parent's padding box — /viewer drops that
   * padding once a stage mounts) minus the series aside on wide screens and
   * the edge toolbar. Only a hint for the engine warm: a miss costs one GL
   * buffer resize on the first drop.
   */
  const expectedStageSize = useCallback((): { width: number; height: number } | undefined => {
    const root = rootRef.current?.parentElement;
    if (!reading || !root) return undefined;
    const narrow = window.matchMedia(NARROW_LAYOUT_MEDIA).matches;
    return {
      width: root.clientWidth - (narrow ? 0 : READING_SERIES_ASIDE_PX),
      height: root.clientHeight - EDGE_TOOLBAR_PX,
    };
  }, [reading]);

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
    // The reading room keeps its warmed engine across Close study, so a
    // second study opens as fast as the first (released on unmount).
    let releaseEngine: (() => void) | null = null;
    let unmounted = false;
    idle(
      () => {
        prewarmLocalIngest();
        // The viewer component and an initialised engine (decode workers
        // booted, codecs registered) — ~0.4 s off the first image.
        void import("@/components/CornerstoneViewer")
          .then((module) => {
            if (unmounted) return;
            if (reading) releaseEngine = module.holdViewerEngine();
            module.prewarmViewerEngine(expectedStageSize());
          })
          .catch(() => undefined);
      },
      { timeout: 500 }
    );
    return () => {
      unmounted = true;
      releaseEngine?.();
    };
  }, [reading, expectedStageSize]);

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
        rawBytes: await localRawBytesHeld(),
      };
    };
    return () => {
      delete w.__flowradViewerStats;
    };
  }, []);

  const release = useCallback((): Promise<void> => {
    const ids = registeredRef.current;
    registeredRef.current = [];
    if (ids.length === 0) return Promise.resolve();
    // Freed back to the page's pre-open footprint, then re-warmed (fresh,
    // empty header workers) so the next drop is as fast as the first.
    return releaseLocalImages(ids)
      .then(() => prewarmLocalIngest())
      .catch(() => undefined);
  }, []);

  // Ctrl+B / Cmd+B: show / hide the series panel (reading room, wide screens).
  const togglePanel = seriesPanel.toggle;
  useEffect(() => {
    if (!reading) return;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      if (!isSeriesPanelShortcut(e, mac)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      togglePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reading, togglePanel]);

  // Leaving the page frees the study (SPA navigation away included).
  useEffect(
    () => () => {
      abortRef.current?.abort();
      void release();
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

  // F: full screen, as on the desktop (the same as the stage's Fullscreen
  // button; Esc or F again leaves). Not while typing or in a dialog.
  useEffect(() => {
    if (!reading) return;
    const onKey = (e: KeyboardEvent) => {
      // Not `defaultPrevented`: Cornerstone prevents every key on the viewport.
      if (e.repeat || !isFullScreenKey(e)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[role="dialog"],[role="menu"]'))) return;
      e.preventDefault();
      void toggleExpanded();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reading, toggleExpanded]);

  // The stage changes shape: fit the image to it once the layout settles.
  useEffect(() => {
    const t = window.setTimeout(() => viewerControls.current?.fit?.(), 250);
    return () => window.clearTimeout(t);
  }, [expanded, focusMode]);

  const toggleFocusMode = useCallback(() => setFocusMode((on) => !on), []);
  useEffect(() => {
    if (!focusMode) return setFocusHint(false);
    setFocusHint(true);
    const t = window.setTimeout(() => setFocusHint(false), 3000);
    return () => window.clearTimeout(t);
  }, [focusMode]);
  // Alt+Shift+Enter toggles it (the desktop's key); Esc leaves it.
  useEffect(() => {
    if (!reading || phase.state !== "open") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === "Enter" && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleFocusMode();
        return;
      }
      if (e.key !== "Escape" || !focusMode || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.closest("input, textarea, select, [role=dialog], [role=menu]"))) return;
      setFocusMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reading, phase.state, focusMode, toggleFocusMode]);
  const distractionFree = useMemo(
    () => (reading ? { on: focusMode, toggle: toggleFocusMode } : null),
    [reading, focusMode, toggleFocusMode]
  );
  // Settings › Scrolling (Help › Customise), remembered in this browser: applied before the first wheel.
  useEffect(() => {
    if (reading) loadScrollPreferences();
  }, [reading]);
  // The scale bar (the desktop's setting, on the image menu here): one choice
  // for every pane, remembered in this browser. Off by default, as on the desktop.
  const [scaleBarOn, setScaleBarOn] = useState(false);
  useEffect(() => {
    try {
      setScaleBarOn(window.localStorage.getItem(SCALE_BAR_STORAGE_KEY) === "1");
    } catch {
      /* storage blocked: off */
    }
  }, []);
  const toggleScaleBar = useCallback(() => {
    setScaleBarOn((on) => {
      try {
        window.localStorage.setItem(SCALE_BAR_STORAGE_KEY, on ? "0" : "1");
      } catch {
        /* storage blocked: still toggles for this visit */
      }
      return !on;
    });
  }, []);
  // Compact series list (the desktop's setting, a toggle on the list here):
  // one line per series instead of thumbnails. Remembered on this device.
  const [compactSeries, setCompactSeries] = useState(false);
  useEffect(() => setCompactSeries(readSeriesListCompact()), []);
  const toggleCompactSeries = useCallback(() => {
    setCompactSeries((on) => {
      writeSeriesListCompact(!on);
      return !on;
    });
  }, []);
  const scaleBar = useMemo(() => (reading ? { on: scaleBarOn, toggle: toggleScaleBar } : null), [reading, scaleBarOn, toggleScaleBar]);

  const pickSeries = useCallback((index: number) => {
    setActiveSeries(index);
    setDrawerOpen(false);
    hapticTick();
  }, []);

  const pickStudySeries = useCallback(
    (studyIndex: number, seriesIndex: number) => {
      // In a grid, the series goes to the focused pane.
      const pane = multiRef.current ? activePaneRef.current : 0;
      if (pane > 0) {
        setExtraPanes((prev) => prev.map((p, i) => (i === pane - 1 ? { study: studyIndex, series: seriesIndex } : p)));
        setDrawerOpen(false);
        hapticTick();
        return;
      }
      setActiveStudy(studyIndex);
      pickSeries(seriesIndex);
    },
    [pickSeries]
  );

  /** Hang a series in a given pane (a series dragged from the panel onto it). */
  const hangInPane = useCallback(
    (pane: number, target: PaneSeries) => {
      setActivePane(pane);
      if (pane === 0) {
        setActiveStudy(target.study);
        pickSeries(target.series);
        return;
      }
      setExtraPanes((prev) => prev.map((p, i) => (i === pane - 1 ? target : p)));
    },
    [pickSeries]
  );

  const closeStudy = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setDrawerOpen(false);
    setExpanded(false);
    setFocusMode(false);
    setOpenReport(null);
    setPhase({ state: "idle" });
    setRestore(null);
    void clearStudyHandles();
    // Close recycles the decode workers (their heaps are the study's memory).
    // Once that is done, boot the fresh ones and re-prime the GL context on
    // idle — the same synthetic warm as page load — so a second study opens
    // as fast as the first.
    void release().then(() => {
      if (!reading) return;
      const idle =
        (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
          .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1));
      idle(
        () => {
          void import("@/components/CornerstoneViewer")
            .then((module) => module.rewarmViewerEngine(expectedStageSize()))
            .catch(() => undefined);
        },
        { timeout: 500 }
      );
    });
  }, [release, reading, expectedStageSize]);

  const ingest = useCallback(
    async (files: File[]) => {
      mark(FILES_RECEIVED_MARK);
      abortRef.current?.abort();
      void release();
      const controller = new AbortController();
      abortRef.current = controller;
      setActiveStudy(0);
      setActiveSeries(0);
      setFirstImageUp(false);
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
        // Decode the first image NOW, while React mounts the viewer (~70 ms)
        // and the viewport asks for its stack. Cornerstone dedupes loads by
        // imageId, so the viewport's own request picks this one up in flight
        // or from the cache. For a compressed study this also starts the one
        // codec its transfer syntax needs (JPEG 2000 → OpenJPEG) — still on
        // demand, just ~200 ms sooner. Local files only; nothing leaves the page.
        const firstId = first.imageIds[0];
        void import("@/components/CornerstoneViewer")
          .then((module) => module.ensureViewerEngine())
          .then(({ core }) => {
            if (controller.signal.aborted) return;
            return core.imageLoader.loadAndCacheImage(firstId).then(() => mark(FIRST_IMAGE_DECODED_MARK));
          })
          .catch(() => undefined); // the viewport retries and reports its own error
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
          void release();
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
        // A popped-out window opens on the series it was popped out with.
        const wanted = wantSeries.current;
        wantSeries.current = null;
        const at = wanted
          ? result.studies.flatMap((st, si) => st.series.map((se, i) => ({ si, i, uid: se.seriesInstanceUID }))).find((x) => x.uid === wanted)
          : undefined;
        if (at) {
          setActiveStudy(at.si);
          setActiveSeries(at.i);
        }
        setOpenedFiles(files);
        // Back where the reader was before a recovery reload (numbers only).
        const place = restorePlace.current;
        restorePlace.current = null;
        if (place) {
          const st = result.studies[place.study ?? -1];
          if (st?.series[place.series ?? -1]) {
            setActiveStudy(place.study);
            setActiveSeries(place.series);
            pendingSlice.current = place.slice ?? null;
          }
        }
        // Current vs prior, as on the desktop: a study and an earlier one of the
        // same patient, opened together, hang side by side (the newest study's
        // primary series beside the prior's closest series), scrolling together
        // from the superior ends. Not when a pop-out or a reload asked for a series.
        const compare = reading && !at && !place ? localComparePlan(result.studies) : null;
        if (compare) {
          setActiveStudy(compare.current.study);
          setActiveSeries(compare.current.series);
          setLayoutId("1x2");
          setExtraPanes([compare.prior]);
          setActivePane(0);
          compareOffset.current = compare.priorOffsetMm;
          setComparison({ current: compare.current, prior: compare.prior, label: compare.label });
        } else {
          compareOffset.current = null;
          setComparison(null);
        }
        setPhase({ state: "open", result, pinned: located ? pinnedNow : null });
        setRestore(null);
        void rememberStudyHandles(openingHandles.current);
        // Recent studies: only what came from a folder / file handle (reopenable).
        // With this browser's salt, the entry holds a patient key, so a later
        // study of the same patient can offer this one as its prior.
        const handlesNow = openingHandles.current;
        const generation = ++openGeneration.current;
        setPriorOffer(null);
        setPriorNotice(null);
        setLibrary(null);
        setLibraryNotice(null);
        // Only while "Remember studies I open" is on (Help › Customise › Privacy & storage).
        if (handlesNow.length > 0 && getRecentStudiesEnabled()) {
          void (async () => {
            const salt = await recentStudySalt();
            const recentEntry = recentStudyEntry(result.studies, Date.now(), salt ?? undefined);
            if (!recentEntry) return;
            await rememberRecentStudy(recentEntry, handlesNow);
            if (generation === openGeneration.current) {
              const kept = (await listRecentStudies()).find((e) => e.key === recentEntry.key)?.keptBytes;
              if (generation === openGeneration.current) setLibrary({ key: recentEntry.key, keptBytes: kept });
            }
            if (!reading || result.studies.length !== 1 || generation !== openGeneration.current) return;
            const prior = priorsAmong(await listRecentStudies(), recentEntry)[0];
            if (prior && generation === openGeneration.current) setPriorOffer({ handles: [...handlesNow], prior });
          })();
        }
        // Decoded + raw must fit the device budget, not decoded alone (see
        // localMemoryBudget.ts). After the engine's init, which sets the plain cap.
        // Key-image series borrow their instances: count each file once.
        const headers = result.studies.flatMap((study) =>
          study.series.flatMap((series) => (isKeyImageSeries(series) ? [] : series.instances))
        );
        void import("@/components/CornerstoneViewer")
          .then((module) => module.ensureViewerEngine())
          .then(() => (controller.signal.aborted ? 0 : applyLocalCacheBudget(headers)))
          .catch(() => undefined);
      } catch (error) {
        rejectFull(new Error("failed"));
        if (controller.signal.aborted) return;
        if (isChunkLoadError(error)) {
          window.dispatchEvent(new CustomEvent(VIEWER_CHUNK_ERROR_EVENT));
          return;
        }
        void release();
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
    openingHandles.current = [handle];
    const files = await filesFromDirectoryHandle(handle);
    if (files.length > 0) void ingest(files);
    else setPhase({ state: "empty", inspected: 0, warnings: [] });
  }, [ingest]);

  // Ctrl/⌘+O: open DICOM files; Ctrl/⌘+Shift+O: open a folder, as on the
  // desktop (instead of the browser's "open a page" / bookmarks). On the
  // landing and with a study open; a key press is the gesture the pickers
  // need. Not while typing or in a dialog.
  useEffect(() => {
    if (!reading) return;
    const onKey = (e: KeyboardEvent) => {
      const what = e.repeat ? null : openKeyOf(e);
      if (!what) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[role="dialog"]'))) return;
      e.preventDefault();
      if (what === "folder" && nativeFolderPicker) return void pickFolderNative();
      document.getElementById(what === "folder" ? folderInputId : fileInputId)?.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reading, nativeFolderPicker, pickFolderNative, folderInputId, fileInputId]);

  // The viewer's code could not be fetched even after retries: a new build
  // replaced the one this tab started with (or the network dropped it). Show
  // a calm "updating" state and reload once, keeping the reader's place;
  // never a raw error on the black stage. A second failure within minutes
  // does not loop: it offers a Reload button instead.
  const recoveringRef = useRef(false);
  const recoverFromChunkError = useCallback(() => {
    if (recoveringRef.current) return;
    recoveringRef.current = true;
    if (!mayReloadForChunkError()) {
      setRecovery("failed");
      return;
    }
    setRecovery("updating");
    const slice = viewerControls.current?.getStartState?.().sliceIndex;
    const place: Record<string, number> = { study: activeStudy, series: activeSeries };
    if (typeof slice === "number" && slice >= 0) place.slice = slice;
    // Long enough that "Updating viewer, reloading…" is actually read (and
    // seen by anything that samples the screen about once a second): 400 ms
    // was a flash, and the e2e caught it only when the chunk failure landed
    // inside its first fast polls.
    window.setTimeout(() => {
      if (!reloadForChunkError(phase.state === "open" || phase.state === "reading" ? place : undefined)) setRecovery("failed");
    }, RECOVERY_NOTICE_MS);
  }, [activeStudy, activeSeries, phase.state]);
  const recoverRef = useRef(recoverFromChunkError);
  recoverRef.current = recoverFromChunkError;

  // Only what the reader is waiting for triggers recovery (the viewer's mount,
  // the study's parse); a background warm-up that fails is simply retried
  // when the code is actually needed.
  useEffect(() => {
    const onChunkError = () => recoverRef.current();
    window.addEventListener(VIEWER_CHUNK_ERROR_EVENT, onChunkError);
    return () => window.removeEventListener(VIEWER_CHUNK_ERROR_EVENT, onChunkError);
  }, []);

  /** Read readable handles and open them where the reader was. False: nothing to open. */
  const openFromHandles = useCallback(
    async (handles: FileSystemHandle[], place: Record<string, number> | undefined): Promise<boolean> => {
      const files = await filesFromHandles(handles);
      if (files.length === 0) return false;
      openingHandles.current = handles;
      restorePlace.current = place ?? null;
      void ingest(files);
      return true;
    },
    [ingest]
  );
  const openFromHandlesRef = useRef(openFromHandles);
  openFromHandlesRef.current = openFromHandles;

  // After a recovery reload: the reader already chose this study, so that is
  // consent to load it. Where the browser still grants read access (Chromium
  // keeps the handle), reopen it straight away, back where they were: no
  // "viewer was updated" screen, no click, no prompt. Only where access has
  // lapsed (the browser itself requires a prompt, inside a click) or there is
  // no handle (other browsers) does the landing offer Reopen / open again.
  useEffect(() => {
    const saved = takeSavedPlace();
    if (!saved?.viewer) return;
    let alive = true;
    restorePlace.current = saved.viewer;
    void (async () => {
      const handles = await recallStudyHandles();
      if (!alive) return;
      if (await studyHandlesReadable(handles)) {
        if (!alive) return;
        if (await openFromHandlesRef.current(handles, saved.viewer)) return;
        if (alive) setRestore({ handles: [], place: saved.viewer });
        return;
      }
      if (alive) setRestore({ handles, place: saved.viewer });
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Recent studies: listed on the landing (reading room, where the browser keeps handles).
  const landingIdle = phase.state === "idle" || phase.state === "empty" || phase.state === "error";
  const rememberRecent = useRecentStudiesEnabled();
  useEffect(() => {
    if (!reading || !nativeFolderPicker || !landingIdle) return;
    if (!rememberRecent) {
      setRecent([]);
      return;
    }
    let alive = true;
    void listRecentStudies().then((list) => {
      if (alive) setRecent(list);
    });
    return () => {
      alive = false;
    };
  }, [reading, nativeFolderPicker, landingIdle, rememberRecent]);

  /** Reopen a recent study (inside the click: the browser asks only if read access lapsed). */
  const openRecent = useCallback(
    async (key: string) => {
      if (recentOpening) return;
      setRecentOpening(key);
      setRecentNotice(null);
      try {
        // Kept in this browser: open the copy (no folder, no permission needed).
        if (recent.find((e) => e.key === key)?.keptBytes) {
          const kept = await keptStudyFiles(key);
          if (kept.length > 0) {
            openingHandles.current = await recentStudyHandles(key);
            restorePlace.current = null;
            void ingest(kept);
            return;
          }
        }
        const handles = await regainStudyHandles(await recentStudyHandles(key));
        if (handles.length === 0) {
          setRecentNotice("Reading that folder was not allowed. Choose it again to open it.");
          return;
        }
        if (!(await openFromHandles(handles, undefined))) {
          setRecentNotice("That folder has moved or holds no images now. Forget it, or choose it again.");
        }
      } finally {
        setRecentOpening(null);
      }
    },
    [recentOpening, openFromHandles, recent, ingest]
  );
  /** "Compare with prior…": reopen this study with the prior (inside the click: the browser asks only if read access lapsed). */
  const comparePrior = useCallback(async () => {
    const offer = priorOffer;
    if (!offer || priorOpening) return;
    setPriorOpening(true);
    setPriorNotice(null);
    try {
      const saved = await recentStudyHandles(offer.prior.key);
      const handles = saved.length > 0 ? await regainStudyHandles([...offer.handles, ...saved]) : [];
      if (handles.length === 0) {
        setPriorNotice(
          saved.length === 0
            ? "That prior is no longer in your recent studies. Open it with this study to compare."
            : "Reading the prior's folder was not allowed. Open it with this study to compare."
        );
        return;
      }
      const priorFiles = await filesFromHandles(saved);
      const currentFiles = priorFiles.length > 0 ? await filesFromHandles(offer.handles) : [];
      if (priorFiles.length === 0 || currentFiles.length === 0) {
        setPriorNotice(`The ${priorFiles.length === 0 ? "prior's" : "study's"} folder has moved or holds no images now.`);
        return;
      }
      openingHandles.current = handles;
      restorePlace.current = null;
      void ingest([...currentFiles, ...priorFiles]);
    } finally {
      setPriorOpening(false);
    }
  }, [priorOffer, priorOpening, ingest]);
  /** "Keep in this browser": copy the open study's files into the study library. */
  const keepOpenStudy = useCallback(async () => {
    const target = library;
    const files = openedFiles;
    if (!target || !files || keeping) return;
    setLibraryNotice(null);
    setKeeping({ done: 0, total: files.length });
    try {
      const bytes = await keepStudy(target.key, files, (done, total) => setKeeping({ done, total }));
      await setRecentStudyKept(target.key, bytes);
      setLibrary((cur) => (cur?.key === target.key ? { key: target.key, keptBytes: bytes } : cur));
    } catch (error) {
      setLibraryNotice(error instanceof KeepStudyError ? error.message : "The copy could not be kept.");
    } finally {
      setKeeping(null);
    }
  }, [library, openedFiles, keeping]);
  const removeKeptCopy = useCallback(async () => {
    const target = library;
    if (!target) return;
    await forgetKeptStudy(target.key);
    await setRecentStudyKept(target.key, undefined);
    setLibrary((cur) => (cur?.key === target.key ? { key: target.key } : cur));
    setLibraryNotice("Copy removed from this browser.");
  }, [library]);
  const forgetRecent = useCallback((key: string) => {
    setRecent((list) => list.filter((e) => e.key !== key));
    setRecentNotice(null);
    void forgetRecentStudy(key);
  }, []);
  const clearRecent = useCallback(() => {
    setRecent([]);
    setRecentNotice(null);
    void clearRecentStudies();
  }, []);

  const reopenStudy = useCallback(async () => {
    if (!restore) return;
    // Inside the reader's click: the browser's own permission prompt, only if it requires one.
    const handles = await regainStudyHandles(restore.handles);
    if (handles.length === 0 || !(await openFromHandles(handles, restore.place))) {
      setRestore({ handles: [], place: restore.place });
    }
  }, [restore, openFromHandles]);

  const onDrop = useCallback(
    async (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      setDragging(false);
      // Handles must be requested before the first await (Chromium only).
      const handlePromises = Array.from(event.dataTransfer.items ?? []).map((item) =>
        (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })
          .getAsFileSystemHandle?.()
          ?.catch(() => null) ?? Promise.resolve(null)
      );
      const files = await filesFromDataTransfer(event.dataTransfer);
      const handles = await Promise.all(handlePromises);
      openingHandles.current = handles.every(Boolean) ? (handles as FileSystemHandle[]) : [];
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

  // ── Hanging layout ──
  const flat = useMemo(() => (result ? flattenSeries(result.studies) : []), [result]);
  const layout = layoutById(layoutId);
  const panesNow = paneCount(layout);
  const multi = !!result && panesNow > 1;
  multiRef.current = multi;
  const offeredLayouts = layoutsForSeriesCount(flat.length, READING_LAYOUTS);
  // Re-hang when the layout or the study changes; keeps what is already hung.
  const mainPaneRef = useRef<PaneSeries>({ study: 0, series: 0 });
  mainPaneRef.current = { study: activeStudy, series: activeSeries };
  useEffect(() => {
    setExtraPanes((prev) => {
      if (panesNow <= 1 || flat.length === 0) return prev.length ? [] : prev;
      const next = hangLocal(layout, flat, [mainPaneRef.current, ...prev]).slice(1);
      return next.length === prev.length && next.every((p, i) => samePane(p, prev[i])) ? prev : next;
    });
    setActivePane((p) => Math.min(p, Math.max(0, panesNow - 1)));
  }, [layout, panesNow, flat]);
  // A new study starts in its first pane.
  useEffect(() => setActivePane(0), [result]);
  // The current-vs-prior label, while the panes still show what the protocol hung.
  const comparisonShown =
    !!comparison &&
    multi &&
    layoutId === "1x2" &&
    samePane({ study: activeStudy, series: activeSeries }, comparison.current) &&
    samePane(extraPanes[0], comparison.prior);
  // Thumbnail menu: series hidden from the list (until "Show all" or another study), and series info.
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<string>>(() => new Set());
  const [seriesInfoFor, setSeriesInfoFor] = useState<{ study: number; series: number } | null>(null);
  useEffect(() => {
    setHiddenSeries(new Set());
    setSeriesInfoFor(null);
  }, [result]);
  // Another layout or study shows the whole grid again.
  useEffect(() => setMaximized(null), [layoutId, result]);
  useEffect(() => setFocusMode(false), [result]);
  const shown = multi && maximized != null && maximized < panesNow ? maximized : null;
  const toggleMaximize = useCallback((pane: number) => {
    setActivePane(pane);
    setMaximized((m) => (m == null ? pane : null));
  }, []);
  // Enter maximises the outlined pane / restores the grid; Esc restores. As on
  // the desktop. Not while typing, or on a focused button (Enter presses it).
  useEffect(() => {
    if (!multi) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return;
      if (e.key !== "Enter" && e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.closest("input, textarea, select, button, a, [role=dialog], [role=menu]"))) return;
      if (e.key === "Escape") {
        if (maximized == null) return;
        setMaximized(null);
        return;
      }
      e.preventDefault();
      toggleMaximize(activePaneRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [multi, maximized, toggleMaximize]);
  const cycleLayout = useCallback(
    () => setLayoutId((current) => nextLayout(current, flat.length, READING_LAYOUTS)),
    [flat.length]
  );
  const setLayoutForGrid = useCallback((rows: number, cols: number) => setLayoutId(layoutForGrid(rows, cols)), []);
  // A series thumbnail's right-click menu, as on the desktop.
  const canAddPane = !!layoutWithMorePanes(layoutId, flat.length, READING_LAYOUTS);
  // "Quick coronal / sagittal": the pane to reformat once its new series is up.
  const [planeRequest, setPlaneRequest] = useState<{ pane: number; plane: "coronal" | "sagittal" } | null>(null);
  const onThumbCommand = useCallback(
    (study: number, series: number, command: MenuCommand) => {
      const target = { study, series };
      if (command === "thumb:open" || command === "thumb:reformat:coronal" || command === "thumb:reformat:sagittal") {
        // The active pane: the main one, or the outlined pane of a grid.
        const pane = multi ? activePane : 0;
        if (multi) hangInPane(pane, target);
        else pickStudySeries(study, series);
        // Quick coronal / sagittal, as on the desktop: that pane shows it reformatted.
        if (command !== "thumb:open") setPlaneRequest({ pane, plane: command === "thumb:reformat:coronal" ? "coronal" : "sagittal" });
        return;
      }
      if (command === "thumb:info") return setSeriesInfoFor({ study, series });
      if (command === "thumb:hide") {
        const uid = result?.studies[study]?.series[series]?.seriesInstanceUID;
        if (uid) setHiddenSeries((prev) => new Set([...prev, uid]));
        return;
      }
      if (command === "thumb:newLayout") {
        const next = layoutWithMorePanes(layoutId, flat.length, READING_LAYOUTS);
        if (!next) return;
        const pane = panesNow; // the first new pane (0-based)
        setLayoutId(next.id);
        // Put the series in the new pane; the re-hang keeps what is already hung.
        setExtraPanes((prev) => {
          const list = prev.slice(0, Math.max(0, pane - 1));
          list[pane - 1] = target;
          return list;
        });
        setActivePane(pane);
      }
    },
    [multi, activePane, hangInPane, pickStudySeries, layoutId, flat.length, panesNow, result]
  );
  /** Shift+1…7, as on the desktop: the nth layout if this study offers it; its label, else null. */
  const pickLayout = useCallback(
    (n: number) => {
      const chosen = layoutForShortcut(n, flat.length);
      if (!chosen) return null;
      setLayoutId(chosen.id);
      return chosen.label;
    },
    [flat.length]
  );
  // ── Linked scrolling between panes (lib/paneScrollLink.ts) ──
  // On by default, like the reading room: scroll one pane and every pane on a
  // parallel plane goes to the same place in the patient. Panes of another
  // study (a prior) are linked at what they show when linking starts.
  const [linkScroll, setLinkScroll] = useState(true);
  // Window / level and zoom + pan follow too when switched on (off by default,
  // as on the desktop). W/L only between panes of the same modality; zoom only
  // between parallel planes.
  const [linkVoi, setLinkVoi] = useState(false);
  const [linkZoom, setLinkZoom] = useState(false);
  // Reference lines: where every other pane's image cuts this one (same frame
  // of reference, non-parallel planes), coloured like that pane. On by default.
  const [refLines, setRefLines] = useState(true);
  const [panePlanes, setPanePlanes] = useState<(RemotePlane | null)[]>([]);
  const paneTargets = useMemo(() => {
    if (!multi || !result) return [];
    return [
      { study: activeStudy, series: result.studies[activeStudy]?.series[activeSeries] ?? null },
      ...extraPanes.slice(0, panesNow - 1).map((t) => ({ study: t.study, series: result.studies[t.study]?.series[t.series] ?? null })),
    ];
  }, [multi, result, activeStudy, activeSeries, extraPanes, panesNow]);
  const paneGeoms = useMemo(() => paneTargets.map((t) => seriesGeometry(t.series)), [paneTargets]);
  const linkLive = useRef({ on: false, voi: false, zoom: false, geoms: paneGeoms, studies: [] as number[], modalities: [] as (string | undefined)[] });
  linkLive.current = {
    on: multi && linkScroll,
    voi: multi && linkVoi,
    zoom: multi && linkZoom,
    geoms: paneGeoms,
    studies: paneTargets.map((t) => t.study),
    modalities: paneTargets.map((t) => t.series?.modality),
  };
  const controlsFor = useCallback(
    (pane: number) => (pane === 0 ? viewerControls.current : paneControls.current[pane - 1]?.current ?? null),
    []
  );
  /** Each pane's position (mm along its normal) when linking started: the cross-study offsets. */
  const anchors = useRef<number[]>([]);
  const captureAnchors = useCallback(() => {
    anchors.current = linkLive.current.geoms.map((g, pane) => {
      const c = controlsFor(pane);
      const index = c?.ready ? c.getStartState?.()?.sliceIndex : undefined;
      return g && index != null ? g.positions[index] ?? Number.NaN : Number.NaN;
    });
  }, [controlsFor]);
  // Re-anchor when linking is switched on or a pane gets another series.
  useEffect(() => {
    if (!multi || !linkScroll) return;
    // A current-vs-prior hang registers its panes itself (below).
    const timer = window.setTimeout(() => compareOffset.current == null && captureAnchors(), 400);
    return () => window.clearTimeout(timer);
  }, [multi, linkScroll, paneTargets, captureAnchors]);
  // Current vs prior: once both panes are up, put the prior at the current's
  // level (superior ends aligned, as on the desktop) and link them there.
  useEffect(() => {
    if (!multi || compareOffset.current == null) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const offset = compareOffset.current;
      const [current, prior] = linkLive.current.geoms;
      const a = controlsFor(0);
      const b = controlsFor(1);
      // Both panes on their whole series (the main pane opens on a one-image preview first).
      const up = !!current && !!prior && !!a?.ready && !!b?.ready && a.imageCount === current.positions.length && b.imageCount === prior.positions.length;
      const index = up ? a!.getStartState?.()?.sliceIndex : undefined;
      if (offset == null || !current || !prior || !b || index == null) {
        // Not a stack with positions (or never up): leave the panes linked where they open.
        if (offset == null || ++tries > 60) {
          window.clearInterval(timer);
          if (compareOffset.current != null) {
            compareOffset.current = null;
            captureAnchors();
          }
        }
        return;
      }
      window.clearInterval(timer);
      compareOffset.current = null;
      const sign = planeSign(current, prior);
      const z = current.positions[index];
      if (!sign || z == null) return captureAnchors();
      anchors.current = [z, sign * z + offset];
      const target = linkedIndex(current, index, prior, offset);
      if (target == null || b.getStartState?.()?.sliceIndex === target) return;
      echoes.current.set(1, target);
      b.applyEvent({ t: 0, type: "slice", index: target });
    }, 150);
    return () => window.clearInterval(timer);
  }, [multi, paneTargets, controlsFor, captureAnchors]);
  // Each pane's visible plane, refreshed once a frame while panes move.
  const planeFrame = useRef(0);
  const refreshPlanes = useCallback(() => {
    if (planeFrame.current) return;
    planeFrame.current = requestAnimationFrame(() => {
      planeFrame.current = 0;
      const count = linkLive.current.geoms.length;
      const next: (RemotePlane | null)[] = Array.from({ length: count }, (_, pane) => {
        const plane = controlsFor(pane)?.viewPlane?.();
        return plane ? { from: `pane-${pane}`, frame: plane.frame, corners: plane.corners, monitorIndex: pane } : null;
      });
      setPanePlanes((prev) =>
        prev.length === next.length && prev.every((p, i) => JSON.stringify(p) === JSON.stringify(next[i])) ? prev : next
      );
    });
  }, [controlsFor]);
  useEffect(() => () => cancelAnimationFrame(planeFrame.current), []);
  /** A slice we moved a pane to: its own echo of that move must not drive the others back. */
  const echoes = useRef(new Map<number, number>());
  const onPaneEvent = useCallback(
    (pane: number, event: ViewerEvent) => {
      const live = linkLive.current;
      if (event.type === "slice" || event.type === "camera") refreshPlanes();
      if (event.type === "voi" && live.voi) {
        live.geoms.forEach((_, other) => {
          if (other === pane || !sameModality(live.modalities[pane], live.modalities[other])) return;
          const c = controlsFor(other);
          // Already there: nothing to apply, and no echo to send back.
          if (!c?.ready || sameWindow(c.getStartState?.(), event.ww, event.wc)) return;
          c.applyEvent({ t: 0, type: "voi", ww: event.ww, wc: event.wc });
        });
        return;
      }
      if (event.type === "camera" && live.zoom) {
        const src = live.geoms[pane];
        live.geoms.forEach((dst, other) => {
          if (other === pane || (src && dst && !planeSign(src, dst))) return;
          const c = controlsFor(other);
          if (!c?.ready || sameCamera(c.getStartState?.(), event.zoom, event.pan)) return;
          c.applyEvent({ t: 0, type: "camera", zoom: event.zoom, pan: event.pan });
        });
        return;
      }
      if (event.type !== "slice") return;
      if (!live.on) return;
      if (echoes.current.get(pane) === event.index) {
        echoes.current.delete(pane);
        return;
      }
      const src = live.geoms[pane];
      if (!src) return;
      live.geoms.forEach((dst, other) => {
        if (other === pane || !dst) return;
        const c = controlsFor(other);
        if (!c?.ready) return;
        let offset = 0;
        if (live.studies[other] !== live.studies[pane]) {
          const sign = planeSign(src, dst);
          const a = anchors.current;
          if (!sign || !Number.isFinite(a[other]) || !Number.isFinite(a[pane])) return;
          offset = a[other] - sign * a[pane];
        }
        const index = linkedIndex(src, event.index, dst, offset);
        if (index == null || c.getStartState?.()?.sliceIndex === index) return;
        echoes.current.set(other, index);
        window.setTimeout(() => {
          if (echoes.current.get(other) === index) echoes.current.delete(other);
        }, 500);
        c.applyEvent({ t: 0, type: "slice", index });
      });
    },
    [controlsFor, refreshPlanes]
  );

  /**
   * The grid's links for the right-click menu and Ctrl/⌘+Shift+L. "Link at
   * current" re-anchors the panes of another study (a prior) at what each
   * shows now, and turns scroll linking on: the desktop's registration.
   */
  const paneLinks = useMemo(
    () =>
      multi
        ? {
            scroll: linkScroll,
            voi: linkVoi,
            zoom: linkZoom,
            lines: refLines,
            toggle: (what: "scroll" | "voi" | "zoom" | "lines") =>
              (what === "scroll" ? setLinkScroll : what === "voi" ? setLinkVoi : what === "zoom" ? setLinkZoom : setRefLines)((on) => !on),
            linkAtCurrent: () => {
              captureAnchors();
              setLinkScroll(true);
            },
          }
        : null,
    [multi, linkScroll, linkVoi, linkZoom, refLines, captureAnchors]
  );

  // New layout or series: planes again once the panes have drawn.
  useEffect(() => {
    if (!multi || !refLines) return;
    const timer = window.setTimeout(refreshPlanes, 500);
    return () => window.clearTimeout(timer);
  }, [multi, refLines, paneTargets, refreshPlanes, shown]);
  /** The planes pane `pane` draws: every other pane's (none while one pane fills the grid). */
  const linesFor = (pane: number): RemotePlane[] | undefined =>
    multi && refLines && shown == null ? (panePlanes.filter((p, i) => i !== pane && p) as RemotePlane[]) : undefined;

  // A pane that changes size keeps its camera: refit every pane once the grid settles.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      viewerControls.current?.fit?.();
      for (const ref of paneControls.current) if (ref.current?.ready) ref.current.fit?.();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [layoutId, shown]);

  // Series thumbnails: one thumbnailer per opened study, freed with it. It
  // waits for the first image (`firstImageUp`) so it never competes with it.
  const thumbs = useMemo(() => (result ? createLocalThumbnailer() : null), [result]);
  useEffect(() => () => thumbs?.dispose(), [thumbs]);
  useEffect(() => {
    if (thumbs && firstImageUp) thumbs.start();
  }, [thumbs, firstImageUp]);
  const imageIdsFor = useCallback(
    (item: LocalSeries) => (result ? seriesImageIds(item, result.imageIdsByFile) : []),
    [result]
  );
  const pinned = phase.state === "open" || phase.state === "reading" ? phase.pinned : null;
  const study: LocalStudy | null = result?.studies[activeStudy] ?? null;
  const series: LocalSeries | null = study?.series[activeSeries] ?? null;
  /** PET / CT fusion: the study's CT and PET volumes (the active one when it is either). */
  const fusionPair = useMemo(() => {
    if (!study || !result) return null;
    const pair = pickFusionPair(
      study.series.map((s) => ({ modality: isKeyImageSeries(s) ? null : s.modality, imageCount: s.imageCount })),
      activeSeries
    );
    if (!pair) return null;
    const ct = study.series[pair.ct]!;
    const pt = study.series[pair.pt]!;
    return {
      ctImageIds: seriesImageIds(ct, result.imageIdsByFile),
      ptImageIds: seriesImageIds(pt, result.imageIdsByFile),
      ctLabel: describeLocalSeries(ct),
      ptLabel: describeLocalSeries(pt),
    };
  }, [study, result, activeSeries]);
  const [fusionOpen, setFusionOpen] = useState<NonNullable<typeof fusionPair> | null>(null);
  // A new study closes it.
  useEffect(() => setFusionOpen(null), [result, activeStudy]);
  const openFusion = useMemo(() => (fusionPair ? () => setFusionOpen(fusionPair) : null), [fusionPair]);
  // The image menu's "Compare with prior…" (one study up, a prior among the recent studies).
  const onComparePrior = useMemo(
    () => (reading && priorOffer && result?.studies.length === 1 && !priorOpening ? () => void comparePrior() : null),
    [reading, priorOffer, result, priorOpening, comparePrior]
  );

  /** Export › DICOM (anonymised): the files behind a pane's series and its study. */
  const exportFilesFor = useCallback(
    (target: { study: number; series: number }) => async (): Promise<ExportDicomFiles | null> => {
      if (!result) return null;
      const inStudy = result.studies[target.study];
      const wanted = inStudy?.series[target.series];
      if (!inStudy || !wanted || isKeyImageSeries(wanted)) return null;
      const groups = await Promise.all(
        inStudy.series.filter((s) => !isKeyImageSeries(s)).map((s) => localSeriesFiles(s, result.imageIdsByFile))
      );
      return { series: await localSeriesFiles(wanted, result.imageIdsByFile), study: groups.filter((g) => g.length > 0) };
    },
    [result]
  );
  const pinnedIsActive =
    !!pinned && (phase.state === "reading" || !!series?.instances.some((i) => i.fileName === pinned.fileName));
  // Multi-monitor UI only with two or more monitors (lib/screens.ts).
  const multipleScreens = useMultipleScreens();

  const popOut = usePopOutWindows({
    files: openedFiles,
    series,
    studyUid: study?.studyInstanceUID ?? null,
    controls: viewerControls,
    onHandoff: (h) => {
      wantSeries.current = h.seriesUid;
      void ingest(h.files);
    },
  });
  const popOutOffered = reading && multipleScreens && phase.state === "open";
  const popOutNow = useCallback(() => {
    setPopOutNote(popOut.popOut() ? "Opened in a new window. Drag it to another monitor." : "The browser blocked the new window. Allow pop-ups for this site.");
  }, [popOut]);
  // Ctrl/⌘+Alt+N: the same as "Pop out to new window", as the desktop sends the
  // layout to the next monitor. Only where that button is offered (two or more
  // monitors); not while typing or in a dialog.
  useEffect(() => {
    if (!popOutOffered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !isPopOutKey(e)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[role="dialog"]'))) return;
      e.preventDefault();
      popOutNow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popOutOffered, popOutNow]);

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
  const landingStatus: LandingStatus =
    phase.state === "reading"
      ? { kind: "reading", progress: <ReadingProgress progress={phase.progress} centered landing /> }
      : phase.state === "empty"
        ? {
            kind: "empty",
            description:
              phase.warnings[0] ??
              `Inspected ${formatCount(phase.inspected)} ${phase.inspected === 1 ? "file" : "files"} and none were DICOM images. A study CD usually has them under a DICOM/ folder.`,
          }
        : phase.state === "error"
          ? { kind: "error", description: phase.message }
          : restore && phase.state === "idle"
            ? {
                kind: "restored",
                description:
                  restore.handles.length > 0
                    ? "A new version arrived while your study was open. Reopen it to continue where you were. Your files stayed on this computer."
                    : "A new version arrived while your study was open. Open it again to continue where you were. Your files stayed on this computer.",
              }
            : { kind: "idle" };
  const modality = series?.modality ?? pinned?.modality;
  const showStage = !!source && (phase.state === "open" || phase.state === "reading");

  // On the free viewer's landing the actions wear the brand green (tokens in
  // .viewer-shell); elsewhere they are the app's own buttons.
  const brandPrimary = reading
    ? "bg-vl-brand text-vl-bg hover:bg-vl-brand/90 focus-visible:ring-vl-brand focus-visible:ring-offset-vl-bg"
    : undefined;
  const brandSecondary = reading
    ? "border-vl-border bg-vl-bg text-vl-fg hover:bg-vl-brand-soft focus-visible:ring-vl-brand focus-visible:ring-offset-vl-bg"
    : undefined;
  const folderButton = nativeFolderPicker ? (
    <Button
      onClick={() => void pickFolderNative()}
      leadingIcon={<FolderOpen aria-hidden />}
      className={brandPrimary}
    >
      Choose a folder
    </Button>
  ) : (
    <FilePickerButton inputId={folderInputId} leadingIcon={<FolderOpen aria-hidden />} className={brandPrimary}>
      Choose a folder
    </FilePickerButton>
  );

  // The bundled, de-identified sample (lib/anonymizeTeachingDicom.ts), fetched
  // only when asked for: the landing itself makes no request for it.
  const [sampleState, setSampleState] = useState<"idle" | "loading" | "error">("idle");
  const openSample = useCallback(async () => {
    setSampleState("loading");
    try {
      const response = await fetch(SAMPLE_STUDY_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      openingHandles.current = [];
      setSampleState("idle");
      void ingest([new File([blob], "FlowRad-sample-MR.dcm", { type: "application/dicom" })]);
    } catch {
      setSampleState("error");
    }
  }, [ingest]);

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
      {result && offeredLayouts.length > 1 && (
        <LayoutPicker
          value={layoutId}
          options={offeredLayouts}
          onChange={setLayoutId}
          dark={reading}
          links={multi ? { scroll: linkScroll, voi: linkVoi, zoom: linkZoom, lines: refLines } : null}
          onToggleLink={(what) =>
            (what === "scroll" ? setLinkScroll : what === "voi" ? setLinkVoi : what === "zoom" ? setLinkZoom : setRefLines)((on) => !on)
          }
        />
      )}
      {reading && librarySupported && library && openedFiles && rememberRecent && (
        <StudyLibraryControl
          keptBytes={library.keptBytes}
          totalBytes={openedFiles.reduce((n, f) => n + f.size, 0)}
          keeping={keeping}
          notice={libraryNotice}
          onKeep={() => void keepOpenStudy()}
          onRemove={() => void removeKeptCopy()}
        />
      )}
      {priorNotice && (
        <p role="status" className="text-xs text-warning">
          {priorNotice}
        </p>
      )}
      {comparisonShown && (
        <p
          data-testid="hanging-label"
          title="Hanging protocol: current vs prior"
          className={cn("flex items-center gap-1.5 text-xs tabular-nums", reading ? "text-white/70" : "text-secondary")}
        >
          <Columns2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{comparison?.label}</span>
        </p>
      )}
      {result && study ? (
        <SeriesList
          result={result}
          activeStudy={activePane > 0 && multi ? extraPanes[activePane - 1]?.study ?? activeStudy : activeStudy}
          activeSeries={activePane > 0 && multi ? extraPanes[activePane - 1]?.series ?? activeSeries : activeSeries}
          panes={multi ? [{ study: activeStudy, series: activeSeries }, ...extraPanes.slice(0, panesNow - 1)] : undefined}
          onPick={pickStudySeries}
          onOpenReport={setOpenReport}
          thumbMenu={reading ? { canAddPane, onCommand: onThumbCommand } : undefined}
          hidden={reading ? hiddenSeries : undefined}
          onShowHidden={() => setHiddenSeries(new Set())}
          compact={reading && compactSeries}
          onToggleCompact={reading ? toggleCompactSeries : undefined}
          dark={reading}
          thumbs={thumbs}
          imageIdsFor={imageIdsFor}
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
        {folderWatch.supported && <WatchFoldersEntry supported fresh={folderWatch.fresh} dark={reading} onOpen={openWatch} />}
      </div>
    </div>
  );

  if (recovery) {
    return (
      <div className={cn("flex flex-col", reading ? "h-full min-h-0" : "min-h-96")}>
        {recovery === "updating" ? (
          <UpdatingNotice />
        ) : (
          <div
            data-testid="viewer-recovery"
            role="alert"
            className="flex h-full min-h-64 w-full flex-1 items-center justify-center bg-imaging p-6 text-white"
          >
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <p className="text-base font-semibold">The viewer could not load</p>
              <p className="text-sm text-white/70">
                Check your connection, then reload the page. Your files stayed on this computer.
              </p>
              <Button variant="imaging" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={cn("flex flex-col gap-4", reading && "h-full min-h-0")}>
      {seriesInfoFor && result?.studies[seriesInfoFor.study]?.series[seriesInfoFor.series] && (() => {
        const info = result.studies[seriesInfoFor.study]!.series[seriesInfoFor.series]!;
        return (
          <DicomTagsDialog
            open
            onClose={() => setSeriesInfoFor(null)}
            imageId={imageIdsFor(info)[0] ?? null}
            title="Series info"
            description={describeLocalSeries(info)}
            summary={localSeriesSummary(info)}
            tone={reading ? "reading" : "app"}
          />
        );
      })()}
      {folderWatch.watcher && watchOpen && (
        <WebWatchFoldersDialog
          open
          onClose={() => setWatchOpen(false)}
          watcher={folderWatch.watcher}
          tone={!reading ? "app" : phase.state === "open" ? "reading" : "viewer"}
          onOpenFiles={(files) => {
            openingHandles.current = [];
            void ingest(files);
          }}
        />
      )}
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
          openingHandles.current = [];
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
          openingHandles.current = [];
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
            <CollapsiblePanel
              label="Series"
              collapsed={seriesPanel.collapsed}
              onToggle={seriesPanel.toggle}
              shortcut={[modKey, "B"]}
              widthClassName="w-72"
              className="hidden lg:flex"
            >
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">{sidePanel}</div>
            </CollapsiblePanel>
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
              "relative min-w-0 flex-1 scroll-mt-4",
              reading && "flex min-h-0 flex-col bg-imaging",
              (expanded || focusMode) && "fixed inset-0 z-40 flex flex-col bg-imaging pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
            )}
            data-distraction-free={focusMode ? "true" : undefined}
          >
            {fusionOpen && (
              <WebFusionOverlay
                ctImageIds={fusionOpen.ctImageIds}
                ptImageIds={fusionOpen.ptImageIds}
                ctLabel={fusionOpen.ctLabel}
                ptLabel={fusionOpen.ptLabel}
                onExit={() => setFusionOpen(null)}
              />
            )}
            {/* Two or more monitors: open this series in another browser window (drag it there).
                Already-open pop-outs keep their "linked" toggle even if a monitor is unplugged. */}
            {focusMode && (
              <div
                role="status"
                className={cn(
                  "pointer-events-none absolute left-1/2 top-3 z-50 -translate-x-1/2 rounded-full border border-white/15 bg-black/75 px-3 py-1.5 text-xs text-white/85 shadow-lg backdrop-blur transition-opacity duration-500",
                  focusHint ? "opacity-100" : "opacity-0"
                )}
              >
                Distraction-free reading · Esc or Alt+Shift+Enter to leave
              </div>
            )}
            {!expanded && !focusMode && phase.state === "open" && (multipleScreens || popOut.hasOtherWindows) && (
              <div className="mb-2 hidden items-center gap-2 lg:flex">
                {multipleScreens && (
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon={<ExternalLink className="h-4 w-4" aria-hidden />}
                  onClick={popOutNow}
                >
                  Pop out to new window
                </Button>
                )}
                {popOut.hasOtherWindows && (
                  <Button
                    size="sm"
                    variant={popOut.linked ? "primary" : "secondary"}
                    aria-pressed={popOut.linked}
                    leadingIcon={popOut.linked ? <Link2 className="h-4 w-4" aria-hidden /> : <Unlink className="h-4 w-4" aria-hidden />}
                    onClick={popOut.toggleLinked}
                  >
                    {popOut.linked ? "Windows linked" : "Windows unlinked"}
                  </Button>
                )}
                {popOutNote && (
                  <span role="status" className="truncate text-xs text-secondary">
                    {popOutNote}
                  </span>
                )}
              </div>
            )}
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
                title={expanded ? "Exit fullscreen (F or Esc)" : "Fullscreen (F)"}
                size="sm"
                onClick={() => void toggleExpanded()}
                className={expanded || reading ? "text-white hover:bg-white/10" : undefined}
              >
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </IconButton>
            </div>
            <div className={cn((expanded || reading || multi) && "flex min-h-0 flex-1 flex-col")}>
              {/* One tree in every layout, so the main viewer never remounts when
                  the grid appears: in 1 up the grid and pane wrappers are
                  `display: contents`. */}
              <div
                data-testid={multi ? "viewer-grid" : undefined}
                data-maximized={shown ?? undefined}
                className={cn(multi ? cn("grid min-h-0 flex-1 gap-px bg-[#1F1F1F]", shown != null ? GRID_CLASS["1x1"] : GRID_CLASS[layoutId]) : "contents")}
              >
                <ViewerPane
                  index={0}
                  multi={multi}
                  active={activePane === 0}
                  onDropSeries={hangInPane}
                  hidden={shown != null && shown !== 0}
                  maximized={shown === 0}
                  onToggleMaximize={toggleMaximize}
                >
                  <CornerstoneViewer
                    key={viewerKey}
                    source={source}
                    modality={modality}
                    controls={viewerControls}
                    onEvent={(event) => {
                      popOut.onViewerEvent(event);
                      onPaneEvent(0, event);
                    }}
                    chrome={focusMode ? "off" : expanded || reading || multi ? "edge" : "dock"}
                    toolbarHost={multi && !focusMode ? barHost : undefined}
                    distractionFree={distractionFree}
                    scaleBar={scaleBar}
                    paneLinks={paneLinks}
                    referencePlanes={linesFor(0)}
                    active={!multi || activePane === 0}
                    onActivate={() => setActivePane(0)}
                    defaultTool="StackScroll"
                    questionMarkHelp
                    features={FREE_VIEWER_FEATURES}
                    popOutOffered={popOutOffered}
                    startPlane={planeRequest?.pane === 0 ? planeRequest.plane : null}
                    onStartPlaneDone={() => setPlaneRequest(null)}
                    exportFiles={exportFilesFor({ study: activeStudy, series: activeSeries })}
                    onFusion={openFusion}
                    onComparePrior={onComparePrior}
                    seriesPanel={reading ? { shown: !seriesPanel.collapsed, toggle: seriesPanel.toggle } : null}
                    onChunkLoadError={recoverFromChunkError}
                    voiceOn={voiceOn}
                    onVoiceChange={setVoiceOn}
                    onCycleLayout={result ? cycleLayout : undefined}
                    onLayout={result ? pickLayout : undefined}
                    onSetLayout={result ? setLayoutForGrid : undefined}
                    currentLayout={result ? { rows: layout.rows, cols: layout.cols } : null}
                    onToggleMaximize={multi ? () => toggleMaximize(0) : undefined}
                    onSeriesStep={(delta) => {
                      const count = study?.series.length ?? 0;
                      if (count > 1) pickSeries((activeSeries + delta + count) % count);
                    }}
                    onReady={(controls) => {
                      setFirstImageUp(true);
                      const slice = pendingSlice.current;
                      if (slice == null || slice < 0) return;
                      pendingSlice.current = null;
                      controls.applyEvent({ t: 0, type: "slice", index: slice });
                    }}
                  />
                </ViewerPane>
                {multi &&
                  result &&
                  extraPanes.slice(0, panesNow - 1).map((target, i) => {
                    const pane = i + 1;
                    const paneSeries = result.studies[target.study]?.series[target.series];
                    if (!paneSeries) return null;
                    const ids = seriesImageIds(paneSeries, result.imageIdsByFile);
                    return (
                      <ViewerPane
                        key={pane}
                        index={pane}
                        multi
                        active={activePane === pane}
                        onDropSeries={hangInPane}
                        hidden={shown != null && shown !== pane}
                        maximized={shown === pane}
                        onToggleMaximize={toggleMaximize}
                      >
                        <CornerstoneViewer
                          key={paneSeries.seriesInstanceUID}
                          source={ids.length ? { kind: "imageIds", key: `pane${pane}:${paneSeries.seriesInstanceUID}`, imageIds: ids } : undefined}
                          modality={paneSeries.modality}
                          controls={paneControls.current[i]}
                          onEvent={(event) => onPaneEvent(pane, event)}
                          chrome={focusMode ? "off" : "edge"}
                          toolbarHost={focusMode ? undefined : barHost}
                          distractionFree={distractionFree}
                          scaleBar={scaleBar}
                          paneLinks={paneLinks}
                          referencePlanes={linesFor(pane)}
                          active={activePane === pane}
                          onActivate={() => setActivePane(pane)}
                          instanceId={`local-pane-${pane}`}
                          defaultTool="StackScroll"
                          questionMarkHelp
                          features={FREE_VIEWER_FEATURES}
                          popOutOffered={popOutOffered}
                          startPlane={planeRequest?.pane === pane ? planeRequest.plane : null}
                          onStartPlaneDone={() => setPlaneRequest(null)}
                          exportFiles={exportFilesFor(target)}
                          onFusion={openFusion}
                    onComparePrior={onComparePrior}
                          seriesPanel={reading ? { shown: !seriesPanel.collapsed, toggle: seriesPanel.toggle } : null}
                          onChunkLoadError={recoverFromChunkError}
                          onCycleLayout={cycleLayout}
                          onLayout={pickLayout}
                          onSetLayout={setLayoutForGrid}
                          currentLayout={{ rows: layout.rows, cols: layout.cols }}
                          onToggleMaximize={() => toggleMaximize(pane)}
                          onSeriesStep={(delta) => {
                            const count = flat.length;
                            if (count < 2) return;
                            const at = flat.findIndex((f) => samePane(f, target));
                            hangInPane(pane, flat[(at + delta + count) % count]!);
                          }}
                          className="h-full w-full"
                        />
                      </ViewerPane>
                    );
                  })}
              </div>
              {/* One toolbar for the whole grid; it acts on the outlined pane. */}
              {multi && <div ref={setBarHost} className={cn("shrink-0", focusMode && "hidden")} />}
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
                activeStudy={activeStudy}
                activeSeries={activeSeries}
                onPick={pickStudySeries}
                onOpenReport={(doc) => {
                  setDrawerOpen(false);
                  setOpenReport(doc);
                }}
                hideHeading
                thumbs={thumbs}
                imageIdsFor={imageIdsFor}
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
      ) : reading ? (
        <ViewerLanding
          status={landingStatus}
          dragging={dragging}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onCancel={closeStudy}
          onSample={() => void openSample()}
          sampleState={sampleState}
          recent={
            reading && nativeFolderPicker && !rememberRecent ? (
              <p data-testid="recent-studies-off" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-vl-muted">
                <span>Recent studies are off: nothing you open is remembered in this browser.</span>
                <button
                  type="button"
                  onClick={() => void setRecentStudiesEnabled(true)}
                  className="rounded-md px-1 font-medium text-vl-fg underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vl-brand"
                >
                  Turn on
                </button>
              </p>
            ) : (
            <RecentStudies
              entries={recent}
              opening={recentOpening}
              notice={recentNotice}
              onOpen={(key) => void openRecent(key)}
              onForget={forgetRecent}
              onClear={clearRecent}
              now={Date.now()}
            />
            )
          }
          actions={
            <>
              {restore && phase.state === "idle" && restore.handles.length > 0 && (
                <Button onClick={() => void reopenStudy()} className={brandPrimary}>
                  Reopen study
                </Button>
              )}
              {folderButton}
              <FilePickerButton
                inputId={fileInputId}
                variant="secondary"
                leadingIcon={<FileArchive aria-hidden />}
                className={brandSecondary}
              >
                Choose files
              </FilePickerButton>
              {folderWatch.supported && (
                <WatchFoldersEntry
                  supported
                  fresh={folderWatch.fresh}
                  onOpen={openWatch}
                  variant="secondary"
                  className={cn("h-10 px-4 text-sm", brandSecondary)}
                />
              )}
            </>
          }
        />
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
                restore && phase.state === "idle"
                  ? "The viewer was updated"
                  : phase.state === "empty"
                  ? "No DICOM images in that selection"
                  : phase.state === "error"
                    ? "That study could not be read"
                    : reading
                      ? "Drop a study to view it"
                      : "Open a study from this computer"
              }
              description={
                restore && phase.state === "idle"
                  ? restore.handles.length > 0
                    ? "A new version arrived while your study was open. Reopen it to continue where you were. Your files stayed on this computer."
                    : "A new version arrived while your study was open. Open it again to continue where you were. Your files stayed on this computer."
                  : phase.state === "empty"
                  ? phase.warnings[0] ??
                    `Inspected ${formatCount(phase.inspected)} ${phase.inspected === 1 ? "file" : "files"} and none were DICOM images. A study CD usually has them under a DICOM/ folder.`
                  : phase.state === "error"
                    ? phase.message
                    : "A folder, a ZIP, a CD or loose DICOM files. They are read in this browser — nothing is uploaded, and no account is needed."
              }
              action={
                <div className="flex flex-col items-center gap-3">
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {restore && phase.state === "idle" && restore.handles.length > 0 && (
                      <Button variant={reading ? "imaging" : "primary"} onClick={() => void reopenStudy()}>
                        Reopen study
                      </Button>
                    )}
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
                  <WatchFoldersEntry supported={folderWatch.supported} fresh={folderWatch.fresh} dark={reading} onOpen={openWatch} />
                </div>
              }
            />
          )}
        </div>
      )}
      <StructuredReportDialog report={openReport} onClose={() => setOpenReport(null)} tone="reading" />
    </div>
  );
}

function ReadingProgress({
  progress,
  dark = false,
  centered = false,
  landing = false,
}: {
  progress: LocalOpenProgress;
  dark?: boolean;
  centered?: boolean;
  /** On the free viewer's landing: its light/dark tokens (.viewer-shell). */
  landing?: boolean;
}) {
  const pct = progress.total > 0 ? Math.min(100, Math.round((progress.read / progress.total) * 100)) : 0;
  return (
    <div className={cn("flex w-full max-w-xs flex-col gap-2", centered && "items-center text-center")} aria-live="polite">
      <p className={cn("text-sm tabular-nums", landing ? "text-vl-fg" : dark ? "text-white" : "text-primary")}>
        Reading {formatCount(progress.read)} of {formatCount(progress.total)} files
      </p>
      <div
        className={cn("h-1 w-full overflow-hidden rounded-full", landing ? "bg-vl-border" : dark ? "bg-white/10" : "bg-elevated")}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Reading study"
      >
        <div className={cn("h-full rounded-full transition-[width] duration-150", landing ? "bg-vl-brand" : "bg-accent")} style={{ width: `${pct}%` }} />
      </div>
      <p className={cn("text-xs tabular-nums", landing ? "text-vl-muted" : dark ? "text-white/60" : "text-secondary")}>
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

/**
 * One pane of the grid: the outline on the focused pane, its number, and a
 * drop target for a series dragged from the panel. In 1 up it adds nothing
 * (`display: contents`), so the single viewer lays out exactly as before.
 */
function ViewerPane({
  index,
  multi,
  active,
  onDropSeries,
  hidden = false,
  maximized = false,
  onToggleMaximize,
  children,
}: {
  index: number;
  multi: boolean;
  active: boolean;
  onDropSeries: (pane: number, target: PaneSeries) => void;
  /** Another pane fills the grid: stay mounted (no reload), just not shown. */
  hidden?: boolean;
  /** This pane fills the grid. */
  maximized?: boolean;
  onToggleMaximize?: (pane: number) => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  if (!multi) return <div className="contents">{children}</div>;
  return (
    <div
      data-testid="viewer-pane"
      data-pane={index}
      data-active={active || undefined}
      data-maximized={maximized || undefined}
      aria-hidden={hidden || undefined}
      className={cn("group/pane relative min-h-0 min-w-0 bg-imaging", hidden && "hidden")}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(SERIES_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const target = parseSeriesDrag(event.dataTransfer.getData(SERIES_DRAG_TYPE));
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        onDropSeries(index, target);
      }}
    >
      {children}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 z-20 transition-shadow duration-100",
          over
            ? "bg-accent/10 shadow-[inset_0_0_0_2px_rgb(var(--accent))]"
            : active
              ? "shadow-[inset_0_0_0_1.5px_rgb(var(--accent))]"
              : ""
        )}
      />
      {/* Beside the bottom orientation letter, not on it: the pane number, then maximise. */}
      <div className="pointer-events-none absolute bottom-1.5 left-1/2 z-30 ml-4 flex items-center gap-1">
        <span
          aria-hidden="true"
          className={cn(
            "rounded px-1.5 text-[10px] font-semibold tabular-nums",
            active ? "bg-accent text-accent-foreground" : "bg-black/60 text-white/70"
          )}
        >
          {/* The pane's colour: its reference line in the other panes is drawn in it. */}
          <span
            aria-hidden="true"
            className="mr-1 inline-block h-1.5 w-1.5 -translate-y-px rounded-full"
            style={{ backgroundColor: monitorColor(index) }}
          />
          {index + 1}
        </span>
        {onToggleMaximize && (
          <Tooltip label={maximized ? "Restore the grid" : "Maximise this pane (or double-click it)"} shortcut={maximized ? ["Esc"] : ["Enter"]} side="top">
            <IconButton
              aria-label={maximized ? `Restore the grid (pane ${index + 1})` : `Maximise pane ${index + 1}`}
              aria-pressed={maximized}
              size="sm"
              onClick={() => onToggleMaximize(index)}
              className={cn(
                // Shown on hover, on the outlined pane and while maximised.
                "pointer-events-auto h-5 w-5 rounded bg-black/60 text-white/80 hover:bg-black/80 hover:text-white [&_svg]:h-3 [&_svg]:w-3",
                "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/pane:opacity-100",
                (active || maximized) && "opacity-100"
              )}
            >
              {maximized ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
            </IconButton>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/** A series dragged from the panel onto a pane: "studyIndex:seriesIndex". */
const SERIES_DRAG_TYPE = "application/x-flowrad-series";

function parseSeriesDrag(data: string): PaneSeries | null {
  const m = /^(\d+):(\d+)$/.exec(data);
  return m ? { study: Number(m[1]), series: Number(m[2]) } : null;
}

/** A layout's icon: its grid of cells, drawn to match every size from 1 up to 3×3. */
function GridGlyph({ id }: { id: HangingLayoutId }) {
  const { rows, cols } = layoutById(id);
  const gap = 1.5;
  const w = (14 - gap * (cols - 1)) / cols;
  const h = (14 - gap * (rows - 1)) / rows;
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.25} aria-hidden="true">
      {Array.from({ length: rows * cols }, (_, i) => (
        <rect
          key={i}
          x={1 + (i % cols) * (w + gap)}
          y={1 + Math.floor(i / cols) * (h + gap)}
          width={w}
          height={h}
          rx={0.75}
        />
      ))}
    </svg>
  );
}

/** Grid template per layout. Static strings so Tailwind keeps them. */
const GRID_CLASS: Record<HangingLayoutId, string> = {
  "1x1": "grid-cols-1 grid-rows-1",
  "1x2": "grid-cols-2 grid-rows-1 max-sm:grid-cols-1 max-sm:grid-rows-2",
  "2x1": "grid-cols-1 grid-rows-2",
  "2x2": "grid-cols-2 grid-rows-2",
  "1x3": "grid-cols-3 grid-rows-1 max-sm:grid-cols-1 max-sm:grid-rows-3",
  "2x3": "grid-cols-3 grid-rows-2",
  "3x3": "grid-cols-3 grid-rows-3",
};

/** 1 up to 3×3: the layouts this drop offers (G cycles them). */
function LayoutPicker({
  value,
  options,
  onChange,
  dark,
  links,
  onToggleLink,
}: {
  value: HangingLayoutId;
  options: { id: HangingLayoutId; label: string }[];
  onChange: (id: HangingLayoutId) => void;
  dark: boolean;
  /** In a grid: what the panes share (null: no grid, no toggles). */
  links: Record<PaneLink, boolean> | null;
  onToggleLink: (what: PaneLink) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
    <div className="flex items-center justify-between gap-2">
      <span className={cn("text-[11px] font-medium uppercase tracking-wide", dark ? "text-white/50" : "text-muted")}>Layout</span>
      <div
        role="radiogroup"
        aria-label="Hanging layout"
        className={cn("inline-flex items-center rounded-lg border p-0.5", dark ? "border-white/10 bg-black/40" : "border-subtle bg-canvas")}
      >
        {options.map((option) => {
          const on = option.id === value;
          return (
            <Tooltip key={option.id} label={option.label} shortcut={["G"]} side="bottom">
              <button
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={`${option.label} layout`}
                onClick={() => onChange(option.id)}
                className={cn(
                  "inline-flex h-7 w-7 items-center justify-center rounded-md transition-[transform,background-color,color] duration-75 active:scale-[0.92]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                  on
                    ? dark
                      ? "bg-white/15 text-white"
                      : "bg-elevated text-primary shadow-sm"
                    : dark
                      ? "text-white/55 hover:text-white"
                      : "text-muted hover:text-primary"
                )}
              >
                <GridGlyph id={option.id} />
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
    {links && (
      <div className="flex items-center justify-between gap-2">
        <span className={cn("text-[11px] font-medium uppercase tracking-wide", dark ? "text-white/50" : "text-muted")}>Link</span>
        <div role="group" aria-label="Link panes" className="flex items-center gap-1">
          {PANE_LINKS.map(({ id, label, aria, hint }) => {
            const on = links[id];
            return (
              <Tooltip key={id} label={hint} side="bottom">
                <button
                  type="button"
                  aria-pressed={on}
                  aria-label={aria}
                  onClick={() => onToggleLink(id)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                    on
                      ? dark
                        ? "border-white/20 bg-white/15 text-white"
                        : "border-strong bg-elevated text-primary shadow-sm"
                      : dark
                        ? "border-transparent text-white/50 hover:text-white"
                        : "border-transparent text-muted hover:text-primary"
                  )}
                >
                  {on ? <Link2 className="h-3 w-3" aria-hidden /> : <Unlink className="h-3 w-3" aria-hidden />}
                  {label}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    )}
    </div>
  );
}

type PaneLink = "scroll" | "voi" | "zoom" | "lines";
const PANE_LINKS: { id: PaneLink; label: string; aria: string; hint: string }[] = [
  { id: "scroll", label: "Scroll", aria: "Link scroll", hint: "Panes scroll together, by position in the patient" },
  { id: "voi", label: "W/L", aria: "Link window / level", hint: "Window / level follows across panes of the same modality" },
  { id: "zoom", label: "Zoom", aria: "Link zoom and pan", hint: "Zoom and pan follow across panes on the same plane" },
  { id: "lines", label: "Lines", aria: "Reference lines", hint: "Where each other pane's image cuts this one (same study, crossing planes)" },
];

/** Study picker + series buttons, shared by the desktop panel and the phone drawer. */
function SeriesList({
  result,
  activeStudy,
  activeSeries,
  onPick,
  onOpenReport,
  hideHeading = false,
  dark = false,
  thumbs,
  imageIdsFor,
  panes,
  thumbMenu,
  hidden,
  onShowHidden,
  compact = false,
  onToggleCompact,
}: {
  /**
   * One line per series instead of thumbnails (the desktop's "Compact series
   * list"), and its toggle in the heading. No toggle: always as `compact` says.
   */
  compact?: boolean;
  onToggleCompact?: () => void;
  /** Series hidden from the list (thumbnail menu › Hide series), and the way back. */
  hidden?: ReadonlySet<string>;
  onShowHidden?: () => void;
  /**
   * Right-click a thumbnail (as on the desktop): open in the active pane, or
   * in a new layout pane when the layout can grow. Absent: no menu.
   */
  thumbMenu?: { canAddPane: boolean; onCommand: (studyIndex: number, seriesIndex: number, command: MenuCommand) => void };
  result: LocalIngestResult;
  activeStudy: number;
  activeSeries: number;
  /** In a grid: what each pane shows (pane 1 first), for the pane badges. */
  panes?: PaneSeries[];
  /** A series of any study was chosen (switches study when needed). */
  onPick: (studyIndex: number, seriesIndex: number) => void;
  /** A structured report (listed under its study) was chosen. */
  onOpenReport: (report: DicomDocument) => void;
  hideHeading?: boolean;
  dark?: boolean;
  thumbs: LocalThumbnailer | null;
  imageIdsFor: (series: LocalSeries) => string[];
}) {
  // Every study the drop produced is listed, each under its own heading: two
  // files of two different studies (a CT and an MR) must both be visible, not
  // one hidden behind a study picker.
  const studies = result.studies;
  const many = studies.length > 1;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; study: number; series: number } | null>(null);
  const seriesTotal = studies.reduce((n, s) => n + s.series.length, 0);
  const imageTotal = studies.reduce((n, s) => n + s.imageCount, 0);
  const only = studies[0];
  return (
    <div className="flex flex-col gap-3">
      {!hideHeading && (
        <div className="flex flex-col gap-1">
          {/* With the toggle: heading and toggle on one row. Without: the heading alone, as before. */}
          {!onToggleCompact ? (
            <h2 className={cn("text-sm font-medium", dark ? "text-white" : "text-primary")}>
              {many ? `${formatCount(studies.length)} studies` : only?.description?.trim() || "Local study"}
            </h2>
          ) : (
          <div className="flex items-start justify-between gap-2">
            <h2 className={cn("min-w-0 text-sm font-medium", dark ? "text-white" : "text-primary")}>
              {many ? `${formatCount(studies.length)} studies` : only?.description?.trim() || "Local study"}
            </h2>
            {(
              <Tooltip label={compact ? "Show thumbnails" : "Compact list: one line per series"} side="bottom">
                <IconButton
                  size="sm"
                  aria-label="Compact series list"
                  aria-pressed={compact}
                  onClick={onToggleCompact}
                  className={cn("-mr-1 -mt-1 shrink-0", dark && "text-white/60 hover:bg-white/10 hover:text-white")}
                >
                  {compact ? <LayoutGrid aria-hidden /> : <List aria-hidden />}
                </IconButton>
              </Tooltip>
            )}
          </div>
          )}
          <p className={cn("text-xs tabular-nums", dark ? "text-white/60" : "text-secondary")}>
            {formatCount(seriesTotal)} series · {formatCount(imageTotal)} images
            {!many && only?.studyDate ? ` · ${only.studyDate}` : ""}
          </p>
        </div>
      )}
      {hidden && hidden.size > 0 && (
        <div className={cn("flex items-center justify-between gap-2 text-xs", dark ? "text-white/60" : "text-secondary")} data-testid="hidden-series">
          <span className="tabular-nums">
            {hidden.size} hidden series
          </span>
          <Button size="sm" variant={dark ? "imaging" : "ghost"} className="h-7 px-2 text-xs" onClick={onShowHidden}>
            Show all
          </Button>
        </div>
      )}
      {studies.map((study, studyIndex) => (
        <section key={study.studyInstanceUID} aria-label={studyLabel(study, studyIndex)} className="flex flex-col gap-2">
          {many && (
            <h3
              className={cn(
                "flex items-baseline gap-1.5 border-t pt-2 text-xs font-medium",
                dark ? "border-white/10 text-white/80" : "border-subtle text-primary"
              )}
            >
              <span className="truncate">{studyLabel(study, studyIndex)}</span>
              <span className={cn("ml-auto shrink-0 font-normal tabular-nums", dark ? "text-white/50" : "text-muted")}>
                {[...new Set(study.series.map((s) => s.modality).filter(Boolean))].join(", ")}
                {study.studyDate ? ` · ${study.studyDate}` : ""}
              </span>
            </h3>
          )}
          <ul className={compact ? "flex flex-col gap-0.5" : "grid grid-cols-2 gap-2"} aria-label="Series" data-compact={compact}>
            {study.series.map((item, index) => {
              if (hidden?.has(item.seriesInstanceUID)) return null;
              const ids = imageIdsFor(item);
              const selected = studyIndex === activeStudy && index === activeSeries;
              const inPanes = (panes ?? [])
                .map((p, pane) => (p.study === studyIndex && p.series === index ? pane + 1 : 0))
                .filter((n) => n > 0);
              const paneBadge =
                inPanes.length > 0 ? (
                  <span
                    className="shrink-0 rounded bg-accent/25 px-1 text-[10px] font-semibold text-white"
                    aria-label={`In pane ${inPanes.join(" and ")}`}
                  >
                    {inPanes.join("·")}
                  </span>
                ) : null;
              return (
                <li key={item.seriesInstanceUID}>
                  <button
                    type="button"
                    onClick={() => onPick(studyIndex, index)}
                    onContextMenu={
                      thumbMenu
                        ? (event) => {
                            event.preventDefault();
                            setMenuAt({ x: event.clientX, y: event.clientY, study: studyIndex, series: index });
                          }
                        : undefined
                    }
                    // Drag onto a pane of the grid to hang it there.
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(SERIES_DRAG_TYPE, `${studyIndex}:${index}`);
                      event.dataTransfer.effectAllowed = "copy";
                    }}
                    aria-pressed={selected}
                    title={describeLocalSeries(item)}
                    className={cn(
                      compact
                        ? "group flex min-h-8 w-full items-center gap-2 rounded-md border px-2 py-1 text-left text-[11px] transition-colors"
                        : "group flex w-full flex-col gap-1 rounded-lg border p-1 text-left text-[11px] transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      dark
                        ? selected
                          ? "border-accent bg-white/[0.10] text-white"
                          : "border-transparent text-white/70 hover:border-white/15 hover:bg-white/[0.05] hover:text-white"
                        : selected
                          ? "border-accent bg-accent-muted/40 text-primary"
                          : "border-transparent text-secondary hover:border-strong hover:bg-elevated/60 hover:text-primary"
                    )}
                  >
                    {compact ? (
                      <>
                        <span className={cn("w-14 shrink-0 truncate font-semibold tabular-nums", dark ? "text-white" : "text-primary")}>
                          {item.modality || "DICOM"}
                          {item.seriesNumber != null ? ` ${item.seriesNumber}` : ""}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{item.description?.trim() || "No description"}</span>
                        {paneBadge}
                        <span className={cn("shrink-0 tabular-nums", dark ? "text-white/50" : "text-muted")}>{formatCount(item.imageCount)}</span>
                      </>
                    ) : (
                    <>
                    <LocalSeriesThumb
                      thumbs={thumbs}
                      seriesKey={item.seriesInstanceUID}
                      imageId={thumbnailImageId(ids)}
                      dark={dark}
                    />
                    <span className="flex items-baseline gap-1 px-0.5 font-medium tabular-nums">
                      <span className="truncate">
                        {item.seriesNumber != null ? `#${item.seriesNumber} · ` : ""}
                        {item.modality || "DICOM"}
                      </span>
                      {paneBadge}
                      <span className={cn("ml-auto shrink-0 font-normal", dark ? "text-white/50" : "text-muted")}>
                        {formatCount(item.imageCount)} im
                      </span>
                    </span>
                    <span
                      className={cn(
                        "line-clamp-2 min-h-[2lh] px-0.5 leading-tight",
                        dark ? "text-white/60 group-hover:text-white/80" : "text-secondary group-hover:text-primary"
                      )}
                    >
                      {item.description?.trim() || "No description"}
                    </span>
                    </>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <StudyReports
            reports={reportsForStudy(study.studyInstanceUID, result.documents)}
            onOpen={onOpenReport}
            dark={dark}
          />
        </section>
      ))}
      {thumbMenu && menuAt && (
        <SeriesThumbMenu
          at={{ x: menuAt.x, y: menuAt.y }}
          canAddPane={thumbMenu.canAddPane}
          canReformat={(studies[menuAt.study]?.series[menuAt.series]?.imageCount ?? 0) >= 3}
          onSelect={(command) => {
            const { study, series } = menuAt;
            setMenuAt(null);
            thumbMenu.onCommand(study, series, command);
          }}
          onClose={() => setMenuAt(null)}
        />
      )}
    </div>
  );
}

/** "Keep in this browser" for the open study (the desktop's archive), or its kept copy. */
function StudyLibraryControl({
  keptBytes,
  totalBytes,
  keeping,
  notice,
  onKeep,
  onRemove,
}: {
  keptBytes?: number;
  totalBytes: number;
  keeping: { done: number; total: number } | null;
  notice: string | null;
  onKeep: () => void;
  onRemove: () => void;
}) {
  return (
    <div data-testid="study-library" className="flex flex-col gap-1.5 rounded-lg border border-white/10 p-2.5 text-xs text-white/70">
      {keptBytes ? (
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 tabular-nums">
            <HardDrive className="h-3.5 w-3.5 text-success" aria-hidden />
            Kept in this browser · {formatBytes(keptBytes)}
          </span>
          <Button size="sm" variant="imaging" className="h-7 px-2 text-xs" onClick={onRemove}>
            Remove copy
          </Button>
        </div>
      ) : (
        <>
          <Button
            size="sm"
            variant="imaging"
            className="h-8 justify-start text-xs"
            leadingIcon={<HardDrive />}
            loading={!!keeping}
            onClick={onKeep}
          >
            {keeping ? `Keeping… ${Math.round((100 * keeping.done) / Math.max(1, keeping.total))} %` : `Keep in this browser (${formatBytes(totalBytes)})`}
          </Button>
          <span className="text-white/50">
            A copy of these files stays in this browser only, so the study reopens from Recent studies without the folder or disc.
          </span>
        </>
      )}
      {notice && (
        <span role="status" className="text-white/70">
          {notice}
        </span>
      )}
    </div>
  );
}

/** A study's Structured Reports (key-image notes are series instead). */
function StudyReports({
  reports,
  onOpen,
  dark,
}: {
  reports: DicomDocument[];
  onOpen: (report: DicomDocument) => void;
  dark: boolean;
}) {
  if (reports.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h4
        className={cn(
          "px-1 text-[11px] font-semibold uppercase tracking-wide",
          dark ? "text-white/50" : "text-muted"
        )}
      >
        Reports
      </h4>
      <ul aria-label="Reports" className="flex flex-col gap-1">
        {reports.map((doc) => (
          <li key={doc.sopInstanceUid ?? doc.fileName}>
            <button
              type="button"
              onClick={() => onOpen(doc)}
              className={cn(
                "flex min-h-11 w-full items-center gap-2 rounded-lg border border-transparent px-2 py-2 text-left text-xs transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                dark
                  ? "text-white/70 hover:border-white/15 hover:bg-white/[0.05] hover:text-white"
                  : "text-secondary hover:border-strong hover:bg-elevated/60 hover:text-primary"
              )}
            >
              <FileText className={cn("h-4 w-4 shrink-0", dark ? "text-white/50" : "text-muted")} aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{doc.title}</span>
              <span className={cn("shrink-0 tabular-nums", dark ? "text-white/50" : "text-muted")}>SR</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Study 2 · e+1" — numbered, so two studies with the same description stay distinct. */
function studyLabel(study: LocalStudy, index: number): string {
  const description = study.description?.trim();
  return description ? `Study ${index + 1} · ${description}` : `Study ${index + 1}`;
}

function withRelativePath(file: File, path: string): File {
  // Preserve the path so lib/localStudy can group loose files by folder.
  Object.defineProperty(file, "webkitRelativePath", { value: path, configurable: true });
  return file;
}

/** Every file under a File System Access directory handle, with its path. */
/** Every file under these folder / file handles (a moved or deleted one is skipped). */
async function filesFromHandles(handles: readonly FileSystemHandle[]): Promise<File[]> {
  const files: File[] = [];
  for (const handle of handles) {
    try {
      if (handle.kind === "directory") files.push(...(await filesFromDirectoryHandle(handle as FileSystemDirectoryHandle)));
      else files.push(await (handle as FileSystemFileHandle).getFile());
    } catch {
      /* moved or deleted since */
    }
  }
  return files;
}

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

/** Shown while the page reloads onto the live build (never a raw error). */
function UpdatingNotice() {
  return (
    <div
      data-testid="viewer-updating"
      role="status"
      aria-live="polite"
      className="flex h-full min-h-64 w-full flex-1 items-center justify-center bg-imaging p-6 text-white"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <Spinner size="md" label="Updating viewer" />
        <p className="text-sm font-medium">Updating viewer, reloading…</p>
        <p className="text-xs text-white/60">Your files stay on this computer.</p>
      </div>
    </div>
  );
}
