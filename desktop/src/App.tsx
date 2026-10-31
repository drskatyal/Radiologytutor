// RadLearn Viewer — the window.
//
// Owns: what is open (studies, source), how it is hung (layout, which series in
// which cell), the left-button tool, view toggles, and the open flow. The
// open flow is progressive: headers stream in from the Rust scanner, the first
// series hangs as soon as one image is known, and the stack grows in place.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Disc3, FolderOpen, ShieldCheck, X } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import type { WindowPreset } from "@/lib/windowPresets";
import {
  appVersion,
  benchEnabled,
  benchReport,
  cancelScan,
  historyClear,
  historyList,
  historyRecord,
  historyRemove,
  imageUrlFor,
  invoke,
  isTauri,
  listen,
  pickFiles,
  pickFolder,
  scanPaths,
  settingsGet,
  settingsSet,
  takeLaunchPaths,
} from "./platform";
import { headersFromBrowserFiles } from "./browserSource";
import { buildStudies, primarySeriesIndex } from "./study";
import { historyEntryFor, sourceKey, type HistoryEntry } from "./history";
import type { DesktopHeader, OpenedSource, ScanProgress, SourceKind, ViewerSeries, ViewerStudy } from "./types";
import { resolveShortcut, type ShortcutAction } from "./shortcuts";
import { StartScreen } from "./components/StartScreen";
import { Toolbar } from "./components/Toolbar";
import {
  CustomWindowDialog,
  DEFAULT_SETTINGS,
  DiscPickerDialog,
  SettingsDialog,
  ShortcutsDialog,
  type ViewerSettings,
} from "./components/Dialogs";
import { SeriesBrowser } from "./viewer/SeriesBrowser";
import { StackViewport } from "./viewer/StackViewport";
import { getHandle, onHandlesChanged } from "./viewer/handles";
import {
  clearAnnotations,
  getEngine,
  prewarmEngine,
  setGroupLeftTool,
  setReferenceSource,
  setScaleOverlay,
  setSynchronized,
  STACK_GROUP,
  undoLastAnnotation,
} from "./viewer/engine";
import { windowPresetsFor } from "./viewer/presets";

type ScanState = { label: string; progress: ScanProgress | null } | null;

const cellKey = (i: number) => `cell-${i}`;
const viewportIdFor = (i: number) => `vp-${i}`;

/** Fill a resized grid: keep what is on screen, then hang unseen series in order. */
export function hangSeries(previous: (string | null)[], size: number, order: string[]): (string | null)[] {
  const next = Array.from({ length: size }, (_, i) => previous[i] ?? null);
  const shown = new Set(next.filter(Boolean));
  const queue = order.filter((uid) => !shown.has(uid));
  for (let i = 0; i < next.length; i += 1) {
    if (!next[i] && queue.length) next[i] = queue.shift()!;
  }
  return next;
}

export default function App() {
  const { toast } = useToast();
  const [version, setVersion] = useState("");
  const [settings, setSettings] = useState<ViewerSettings>(DEFAULT_SETTINGS);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [studies, setStudies] = useState<ViewerStudy[]>([]);
  const [source, setSource] = useState<OpenedSource | null>(null);
  const [scan, setScan] = useState<ScanState>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [growing, setGrowing] = useState(false);
  const [layout, setLayout] = useState({ rows: 1, cols: 1 });
  const [cells, setCells] = useState<(string | null)[]>([null]);
  const [activeCell, setActiveCell] = useState(0);
  const [maximized, setMaximized] = useState<number | null>(null);
  const [leftTool, setLeftTool] = useState("StackScroll");
  const [overlay, setOverlay] = useState(true);
  const [annotationsVisible, setAnnotationsVisible] = useState(true);
  const [syncScroll, setSyncScroll] = useState(false);
  const [referenceLines, setReferenceLines] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(true);
  const [distractionFree, setDistractionFree] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<null | "help" | "window" | "settings" | "disc">(null);
  const [handlesVersion, setHandlesVersion] = useState(0);
  const [, setTick] = useState(0);
  const browserFileInput = useRef<HTMLInputElement>(null);
  const browserFolderInput = useRef<HTMLInputElement>(null);
  const openSeq = useRef(0);
  const bench = useRef<{ enabled: boolean; t0: number; firstPaint?: number; marks: Record<string, number> }>({
    enabled: false,
    t0: 0,
    marks: {},
  });

  // ───────────── boot ─────────────
  useEffect(() => {
    appVersion().then(setVersion, () => setVersion("dev"));
    settingsGet<ViewerSettings>().then((s) => {
      const merged = { ...DEFAULT_SETTINGS, ...s };
      setSettings(merged);
      setOverlay(merged.showOverlay);
    });
    historyList<HistoryEntry>().then(setHistory, () => setHistory([]));
    benchEnabled().then((on) => (bench.current.enabled = on));
    // First paint is done; start parsing the engine in idle time so the first
    // study opens without paying for it.
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (idle) idle(() => prewarmEngine());
    else window.setTimeout(prewarmEngine, 200);
    return onHandlesChanged(() => setHandlesVersion((v) => v + 1));
  }, []);

  const updateSettings = useCallback((patch: Partial<ViewerSettings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    if (patch.showOverlay != null) setOverlay(patch.showOverlay);
    void settingsSet<ViewerSettings>(patch);
  }, []);

  // ───────────── derived ─────────────
  const seriesByUid = useMemo(() => {
    const map = new Map<string, { series: ViewerSeries; study: ViewerStudy }>();
    for (const study of studies) for (const series of study.series) map.set(series.uid, { series, study });
    return map;
  }, [studies]);
  const seriesOrder = useMemo(() => studies.flatMap((s) => s.series.map((x) => x.uid)), [studies]);
  const activeSeriesUid = cells[activeCell] ?? null;
  const active = activeSeriesUid ? seriesByUid.get(activeSeriesUid) : undefined;
  const presets = useMemo(() => windowPresetsFor(active?.series.modality ?? ""), [active?.series.modality]);
  const activeHandle = () => getHandle(cellKey(activeCell));

  // ───────────── open flow ─────────────
  const resetWorkspace = useCallback(() => {
    setStudies([]);
    setCells([null]);
    setLayout({ rows: 1, cols: 1 });
    setActiveCell(0);
    setMaximized(null);
  }, []);

  const finishOpen = useCallback(
    async (opened: OpenedSource, built: ViewerStudy[]) => {
      if (built.length === 0) return;
      if (settings.rememberHistory) {
        try {
          setHistory(await historyRecord(historyEntryFor(opened, built)));
        } catch {
          /* history is a convenience; never fail an open over it */
        }
      }
    },
    [settings.rememberHistory]
  );

  const hangFirst = useCallback((built: ViewerStudy[]) => {
    setCells((prev) => {
      if (prev.some(Boolean) || built.length === 0) return prev;
      const study = built[0];
      const first = study.series[primarySeriesIndex(study)];
      return first ? [first.uid, ...prev.slice(1)] : prev;
    });
  }, []);

  const openPaths = useCallback(
    async (paths: string[], kindHint?: SourceKind) => {
      if (!paths.length) return;
      if (!isTauri) {
        toast({ title: "Use Open files or drop files", description: "Opening by path needs the desktop app.", variant: "info" });
        return;
      }
      const seq = ++openSeq.current;
      const t0 = performance.now();
      bench.current.t0 = t0;
      bench.current.marks = {};
      bench.current.firstPaint = undefined;
      resetWorkspace();
      const label = paths[0].split(/[\\/]/).filter(Boolean).pop() || paths[0];
      setScan({ label, progress: null });
      setGrowing(true);

      const acc = new Map<string, DesktopHeader>();
      let timer = 0;
      let firstShown = false;
      const rebuild = () => {
        timer = 0;
        if (seq !== openSeq.current) return;
        const built = buildStudies([...acc.values()]);
        setStudies(built);
        if (!firstShown && built.length) {
          firstShown = true;
          bench.current.marks.firstSeriesHungMs = performance.now() - t0;
          setScan(null); // progressive: the viewer takes over, progress moves to the status bar
          hangFirst(built);
        }
      };

      try {
        const result = await scanPaths(paths, {
          onProgress: (progress) => {
            if (seq !== openSeq.current) return;
            setScan((s) => (s ? { ...s, progress } : s));
            setScanProgress(progress);
          },
          onBatch: (batch) => {
            if (seq !== openSeq.current) return;
            if (!bench.current.marks.firstHeaderMs) bench.current.marks.firstHeaderMs = performance.now() - t0;
            for (const h of batch) acc.set(h.fileName, { ...h, baseImageId: `wadouri:${imageUrlFor(h.fileId)}` });
            if (!firstShown) rebuild();
            else if (!timer) timer = window.setTimeout(rebuild, 250);
          },
        });
        if (seq !== openSeq.current) return;
        window.clearTimeout(timer);
        const headers = result.headers.map((h) => ({ ...h, baseImageId: `wadouri:${imageUrlFor(h.fileId)}` }));
        const built = buildStudies(headers);
        setStudies(built);
        setGrowing(false);
        setScan(null);
        setScanProgress(null);
        if (built.length === 0) {
          toast({
            title: "No DICOM images found",
            description: `Looked at ${result.inspected.toLocaleString()} files in ${result.label}. A study disc usually keeps them under a DICOM folder.`,
            variant: "warning",
            duration: 8000,
          });
          resetWorkspace();
          return;
        }
        hangFirst(built);
        const opened: OpenedSource = {
          key: sourceKey(paths),
          paths,
          kind: kindHint ?? result.kind,
          label: result.label,
        };
        setSource(opened);
        void finishOpen(opened, built);
        for (const w of result.warnings.slice(0, 2)) toast({ title: "Heads up", description: w, variant: "warning", duration: 8000 });
        bench.current.marks.scanDoneMs = performance.now() - t0;
        if (bench.current.enabled) {
          const report = async () => {
            const startup = await invoke<number>("startup_elapsed_ms").catch(() => 0);
            await benchReport({
              source: paths,
              files: result.inspected,
              images: built.reduce((n, s) => n + s.imageCount, 0),
              cacheHits: result.cacheHits,
              usedDicomdir: result.usedDicomdir,
              rust: result.timings,
              ...bench.current.marks,
              firstImagePaintedMs: bench.current.firstPaint,
              processUptimeMs: startup,
            });
          };
          // Wait for the first pixel before reporting.
          const waitPaint = () => (bench.current.firstPaint != null ? report() : window.setTimeout(waitPaint, 20));
          waitPaint();
        }
      } catch (error) {
        if (seq !== openSeq.current) return;
        setScan(null);
        setGrowing(false);
        setScanProgress(null);
        const message = error instanceof Error ? error.message : String(error);
        if (message !== "cancelled") {
          toast({ title: "That could not be opened", description: message, variant: "danger", duration: 8000 });
        }
        resetWorkspace();
      }
    },
    [finishOpen, hangFirst, resetWorkspace, toast]
  );

  const openBrowserFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const seq = ++openSeq.current;
      resetWorkspace();
      setScan({ label: `${files.length} files`, progress: null });
      try {
        const headers = await headersFromBrowserFiles(files, (read, accepted, total) =>
          setScan((s) => (s ? { ...s, progress: { phase: "reading", read, accepted, total } } : s))
        );
        if (seq !== openSeq.current) return;
        const built = buildStudies(headers);
        setStudies(built);
        setScan(null);
        if (!built.length) {
          toast({ title: "No DICOM images found", variant: "warning" });
          return;
        }
        hangFirst(built);
        setSource({ key: `browser:${Date.now()}`, paths: [], kind: "files", label: `${files.length} files` });
      } catch (error) {
        setScan(null);
        toast({ title: "Those files could not be read", description: String(error), variant: "danger" });
      }
    },
    [hangFirst, resetWorkspace, toast]
  );

  const openDialog = useCallback(
    async (what: "files" | "folder" | "disc" | "zip" | "dicomdir") => {
      if (!isTauri) {
        (what === "folder" ? browserFolderInput : browserFileInput).current?.click();
        return;
      }
      if (what === "disc") {
        setDialog("disc");
        return;
      }
      try {
        const paths = what === "folder" ? await pickFolder() : await pickFiles(what === "files" ? "dicom" : what);
        if (paths?.length) void openPaths(paths, what === "dicomdir" ? "dicomdir" : undefined);
      } catch (error) {
        toast({ title: "The open dialog failed", description: String(error), variant: "danger" });
      }
    },
    [openPaths, toast]
  );

  // Launch arguments, Finder "Open with…", and OS file drops.
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void)[] = [];
    (async () => {
      const initial = await takeLaunchPaths();
      if (initial.length) void openPaths(initial);
      off.push(await listen<string[]>("open-paths", (paths) => paths.length && openPaths(paths)));
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      off.push(
        await getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") setDragging(true);
          else if (p.type === "leave") setDragging(false);
          else if (p.type === "drop") {
            setDragging(false);
            if (p.paths.length) void openPaths(p.paths);
          }
        })
      );
    })();
    return () => off.forEach((fn) => fn());
    // openPaths is stable enough: re-subscribing on every settings change would drop events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ───────────── engine wiring ─────────────
  useEffect(() => {
    if (!studies.length) return;
    let cancelled = false;
    getEngine().then((engine) => {
      if (cancelled) return;
      setGroupLeftTool(engine, STACK_GROUP, leftTool);
    });
    return () => {
      cancelled = true;
    };
  }, [leftTool, studies.length]);

  const visibleCells = useMemo(
    () => cells.map((uid, i) => ({ uid, i })).filter(({ i }) => maximized == null || i === maximized),
    [cells, maximized]
  );

  useEffect(() => {
    if (!studies.length) return;
    let cancelled = false;
    getEngine().then((engine) => {
      if (cancelled) return;
      const ids = visibleCells.filter((c) => c.uid && getHandle(cellKey(c.i))).map((c) => viewportIdFor(c.i));
      setSynchronized(engine, "slice", ids, syncScroll);
      const activeId = getHandle(cellKey(activeCell)) ? viewportIdFor(activeCell) : null;
      setReferenceSource(engine, activeId, referenceLines && ids.length > 1);
      setScaleOverlay(engine, settings.scaleBar);
    });
    return () => {
      cancelled = true;
    };
  }, [syncScroll, referenceLines, visibleCells, activeCell, handlesVersion, studies.length, settings.scaleBar]);

  useEffect(() => {
    if (!studies.length) return;
    getEngine().then((engine) => {
      const { annotation } = engine.tools;
      for (const a of annotation.state.getAllAnnotations()) {
        if (a.annotationUID) annotation.visibility.setAnnotationVisibility(a.annotationUID, annotationsVisible);
      }
      engine.renderingEngine.render();
    });
  }, [annotationsVisible, studies.length]);

  // ───────────── actions ─────────────
  const applyLayout = useCallback(
    (rows: number, cols: number) => {
      setMaximized(null);
      setLayout({ rows, cols });
      setCells((prev) => hangSeries(prev, rows * cols, seriesOrder));
      setActiveCell((a) => Math.min(a, rows * cols - 1));
    },
    [seriesOrder]
  );

  const showSeries = useCallback(
    (uid: string, cell = activeCell) => {
      setCells((prev) => prev.map((v, i) => (i === cell ? uid : v)));
    },
    [activeCell]
  );

  const applyPreset = useCallback(
    (preset: WindowPreset | null) => {
      const handle = activeHandle();
      if (!handle) return;
      if (preset) handle.setVoi(preset.ww, preset.wc);
      else handle.resetVoi();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeCell]
  );

  const toggleFullscreen = useCallback(async () => {
    if (isTauri) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      await w.setFullscreen(!(await w.isFullscreen()));
    } else if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  }, []);

  const runAction = useCallback(
    (action: ShortcutAction) => {
      const handle = activeHandle();
      switch (action.type) {
        case "open":
          return void openDialog(action.what);
        case "help":
          return setDialog("help");
        case "fullscreen":
          return void toggleFullscreen();
        case "distractionFree":
          return setDistractionFree((v) => !v);
        case "escape":
          if (distractionFree) setDistractionFree(false);
          if (maximized != null) setMaximized(null);
          if (isTauri) {
            void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
              const w = getCurrentWindow();
              if (await w.isFullscreen()) await w.setFullscreen(false);
            });
          }
          return;
      }
      if (!studies.length) return;
      switch (action.type) {
        case "tool":
          return setLeftTool(action.tool);
        case "slice":
          return handle?.step(action.delta);
        case "sliceEdge":
          return handle?.goTo(action.where);
        case "series": {
          if (!seriesOrder.length) return;
          const at = activeSeriesUid ? seriesOrder.indexOf(activeSeriesUid) : -1;
          const next = seriesOrder[(at + action.delta + seriesOrder.length) % seriesOrder.length];
          return showSeries(next);
        }
        case "zoomTo":
          return handle?.zoomTo(action.scale);
        case "zoomBy":
          return handle?.zoomBy(action.factor);
        case "pan":
          return handle?.pan(action.dx, action.dy);
        case "preset": {
          const p = presets[action.ordinal - 1];
          if (p) applyPreset(p);
          return;
        }
        case "presetDefault":
          return applyPreset(null);
        case "customWindow":
          return setDialog("window");
        case "invert":
          return handle?.invert();
        case "rotate":
          return handle?.rotate(action.degrees);
        case "flip":
          return handle?.flip(action.axis);
        case "reset":
          return handle?.reset();
        case "cine":
          handle?.toggleCine();
          return setTick((t) => t + 1);
        case "cineFps":
          if (handle) handle.setCineFps(handle.cine().fps + action.delta);
          return setTick((t) => t + 1);
        case "layout":
          return applyLayout(action.rows, action.cols);
        case "maximizeCell":
          return setMaximized((m) => (m == null && cells.length > 1 ? activeCell : null));
        case "toggleOverlay":
          return setOverlay((v) => !v);
        case "toggleAnnotations":
          return setAnnotationsVisible((v) => !v);
        case "toggleSync":
          return setSyncScroll((v) => !v);
        case "toggleReferenceLines":
          return setReferenceLines((v) => !v);
        case "toggleBrowser":
          return setBrowserOpen((v) => !v);
        case "undoAnnotation":
          return void getEngine().then(undoLastAnnotation);
        case "clearAnnotations":
          return void getEngine().then((e) => clearAnnotations(e));
        default:
          return;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [studies.length, activeCell, presets, seriesOrder, activeSeriesUid, cells.length, maximized, distractionFree, openDialog, applyLayout, applyPreset, showSeries, toggleFullscreen]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (dialog) return;
      const action = resolveShortcut(e);
      if (!action) return;
      e.preventDefault();
      runAction(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runAction, dialog]);

  const goHome = useCallback(() => {
    openSeq.current += 1;
    void cancelScan();
    setScan(null);
    setGrowing(false);
    setSource(null);
    resetWorkspace();
    historyList<HistoryEntry>().then(setHistory, () => undefined);
  }, [resetWorkspace]);

  const onFirstPaint = useCallback(() => {
    if (bench.current.firstPaint == null) bench.current.firstPaint = performance.now() - bench.current.t0;
  }, []);

  // ───────────── render ─────────────
  const handle = activeHandle();
  const cine = handle?.cine() ?? { playing: false, fps: 15 };
  const hasStudy = studies.length > 0;
  const gridCells = maximized != null ? [maximized] : cells.map((_, i) => i);
  const gridShape = maximized != null ? { rows: 1, cols: 1 } : layout;

  return (
    <div
      className="flex h-full flex-col bg-canvas text-primary"
      onDragOver={(e) => {
        if (!isTauri && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => !isTauri && setDragging(false)}
      onDrop={(e) => {
        if (isTauri || !e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void openBrowserFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <input
        ref={browserFileInput}
        type="file"
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void openBrowserFiles(files);
        }}
      />
      <input
        ref={browserFolderInput}
        type="file"
        multiple
        className="sr-only"
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void openBrowserFiles(files);
        }}
      />

      {hasStudy && !distractionFree && (
        <Toolbar
          leftTool={leftTool}
          onTool={setLeftTool}
          presets={presets}
          onPreset={applyPreset}
          onCustomWindow={() => setDialog("window")}
          onInvert={() => handle?.invert()}
          onReset={() => handle?.reset()}
          onRotate={(d) => handle?.rotate(d)}
          layout={layout}
          onLayout={applyLayout}
          syncScroll={syncScroll}
          onToggleSync={() => setSyncScroll((v) => !v)}
          referenceLines={referenceLines}
          onToggleReferenceLines={() => setReferenceLines((v) => !v)}
          overlay={overlay}
          onToggleOverlay={() => setOverlay((v) => !v)}
          cine={cine}
          cineAvailable={(active?.series.imageCount ?? 0) > 1}
          onToggleCine={() => runAction({ type: "cine" })}
          onCineFps={(fps) => {
            handle?.setCineFps(fps);
            setTick((t) => t + 1);
          }}
          onOpen={(w) => void openDialog(w)}
          onHome={goHome}
          onUndo={() => runAction({ type: "undoAnnotation" })}
          onClear={() => runAction({ type: "clearAnnotations" })}
          onFullscreen={() => void toggleFullscreen()}
          onHelp={() => setDialog("help")}
          onSettings={() => setDialog("settings")}
        />
      )}

      <main className="relative flex min-h-0 flex-1">
        {hasStudy ? (
          <>
            {browserOpen && !distractionFree && (
              <aside className="w-[244px] shrink-0 border-r border-subtle bg-surface">
                <SeriesBrowser
                  studies={studies}
                  onScreen={cells}
                  activeSeriesUid={activeSeriesUid}
                  growing={growing}
                  onOpenSeries={(uid) => showSeries(uid)}
                />
              </aside>
            )}
            <section
              aria-label="Viewports"
              className="grid min-w-0 flex-1 gap-px bg-black"
              // Grid shape is user-chosen at runtime.
              style={{
                gridTemplateRows: `repeat(${gridShape.rows}, minmax(0, 1fr))`,
                gridTemplateColumns: `repeat(${gridShape.cols}, minmax(0, 1fr))`,
              }}
            >
              {gridCells.map((i) => {
                const uid = cells[i];
                const entry = uid ? seriesByUid.get(uid) : undefined;
                return (
                  <StackViewport
                    key={i}
                    cellKey={cellKey(i)}
                    viewportId={viewportIdFor(i)}
                    series={entry?.series ?? null}
                    study={entry?.study ?? null}
                    active={i === activeCell && cells.length > 1}
                    showOverlay={overlay}
                    growing={growing}
                    onActivate={() => setActiveCell(i)}
                    onDropSeries={(dropped) => showSeries(dropped, i)}
                    onDoubleClick={() => cells.length > 1 && setMaximized((m) => (m == null ? i : null))}
                    onFirstPaint={onFirstPaint}
                  />
                );
              })}
            </section>
          </>
        ) : (
          <StartScreen
            history={history}
            onOpen={(w) => void openDialog(w)}
            onOpenPaths={(p, kind) => void openPaths(p, kind)}
            onForget={async (key) => setHistory(await historyRemove<HistoryEntry>(key))}
            onClearHistory={async () => {
              await historyClear();
              setHistory([]);
            }}
            version={version}
            dragging={dragging}
          />
        )}

        {scan && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-canvas/80 backdrop-blur-sm" role="status" aria-live="polite">
            <div className="flex w-[360px] flex-col items-center gap-4 rounded-2xl border border-subtle bg-elevated p-6 shadow-lg">
              <Spinner label="Reading study" />
              <div className="text-center">
                <div className="text-sm font-semibold text-primary">Reading {scan.label}</div>
                <div className="mt-1 text-xs text-secondary tabular-nums">
                  {!scan.progress || scan.progress.phase === "listing"
                    ? "Listing files…"
                    : `${scan.progress.read.toLocaleString()} of ${scan.progress.total.toLocaleString()} files · ${scan.progress.accepted.toLocaleString()} images`}
                </div>
              </div>
              {scan.progress && scan.progress.total > 0 && (
                <div className="h-1 w-full overflow-hidden rounded-full bg-overlay">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-150"
                    style={{ width: `${(100 * scan.progress.read) / scan.progress.total}%` }}
                  />
                </div>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={goHome}
                leadingIcon={<X className="h-4 w-4" />}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {dragging && hasStudy && (
          <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent-muted/30">
            <div className="flex items-center gap-2 rounded-full bg-elevated px-4 py-2 text-sm text-primary shadow-lg">
              <FolderOpen className="h-4 w-4 text-accent-bright" aria-hidden /> Drop to open
            </div>
          </div>
        )}
      </main>

      {hasStudy && !distractionFree && (
        <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-subtle bg-surface px-3 text-[11px] text-muted tabular-nums">
          <span className="flex items-center gap-1 text-success">
            <ShieldCheck className="h-3 w-3" aria-hidden /> Offline
          </span>
          <span className="truncate" title={source?.paths.join("\n")}>
            {source?.kind === "disc" && <Disc3 className="mr-1 inline h-3 w-3" aria-hidden />}
            {source?.label}
          </span>
          <span>
            {studies.length} {studies.length === 1 ? "study" : "studies"} · {seriesOrder.length} series ·{" "}
            {studies.reduce((n, s) => n + s.imageCount, 0).toLocaleString()} images
          </span>
          {growing && scanProgress && scanProgress.total > 0 && (
            <span className="flex items-center gap-2 text-secondary">
              <span className="h-1 w-24 overflow-hidden rounded-full bg-overlay">
                <span className="block h-full bg-accent" style={{ width: `${(100 * scanProgress.read) / scanProgress.total}%` }} />
              </span>
              Reading {scanProgress.read.toLocaleString()} / {scanProgress.total.toLocaleString()}
            </span>
          )}
          <span className="ml-auto">
            {syncScroll && "Sync · "}
            {leftTool.replace(/([a-z])([A-Z])/g, "$1 $2")} · Not for diagnostic use
          </span>
        </footer>
      )}

      <ShortcutsDialog open={dialog === "help"} onClose={() => setDialog(null)} />
      <CustomWindowDialog
        open={dialog === "window"}
        onClose={() => setDialog(null)}
        initial={{ ww: handle?.readout()?.ww, wc: handle?.readout()?.wc }}
        onApply={(ww, wc) => handle?.setVoi(ww, wc)}
      />
      <DiscPickerDialog
        open={dialog === "disc"}
        onClose={() => setDialog(null)}
        onPick={(path) => {
          setDialog(null);
          void openPaths([path], "disc");
        }}
        onBrowse={async () => {
          setDialog(null);
          const paths = await pickFolder("Choose the disc or USB drive");
          if (paths?.length) void openPaths(paths, "disc");
        }}
      />
      <SettingsDialog
        open={dialog === "settings"}
        onClose={() => setDialog(null)}
        settings={settings}
        onChange={updateSettings}
        version={version}
      />
      {/* Keep the handles list fresh for the toolbar's cine state. */}
      <span hidden>{handlesVersion}</span>
    </div>
  );
}
