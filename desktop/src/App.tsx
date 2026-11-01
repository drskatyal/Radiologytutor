// FlowRad Viewer — the window.
//
// Owns: what is open (studies, source), how it is hung (layout, which series in
// which cell), the left-button tool, view toggles, and the open flow. The
// open flow is progressive: headers stream in from the Rust scanner, the first
// series hangs as soon as one image is known, and the stack grows in place.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Disc3, FolderOpen, ShieldCheck, X } from "lucide-react";
import { useToast } from "./toast";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import type { WindowPreset } from "@flowrad/viewer-core";
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
  initProtocol,
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
import { useUpdater } from "./components/Updates";
import { useSyncStatus } from "./components/Account";
import { DEFAULT_SETTINGS, type ViewerSettings } from "./settings";
import { setScrollPreferences } from "@flowrad/viewer-core";
import { hangingPlanFor } from "./hanging";
import { withKeyImageSeries, type DicomDocument } from "./documents";
import type { VolumeMode } from "./viewer/VolumeWorkspace";
import { getHandle, onHandlesChanged } from "./viewer/handles";
import {
  clearAnnotations,
  engineTimings,
  enginePeek,
  leaveVolumeMemory,
  getEngine,
  prewarmEngine,
  setGroupLeftTool,
  setReferenceSource,
  setScaleOverlay,
  linkStacksAtCurrent,
  registerGeometry,
  setStackOffset,
  setSynchronized,
  STACK_GROUP,
  undoLastAnnotation,
} from "./viewer/engine";
import { windowPresetsFor } from "./viewer/presets";
import { hangSeries } from "./layout";
import { firstImagePixelStats } from "./viewer/pixelStats";
import { paintHealth, sampleCanvas } from "./viewer/paintCheck";
import { cacheFacts, gpuInfo, memoryStats } from "./viewer/memory";
import { longTasks } from "./perfWatch";

// Everything the start screen does not need loads on demand: the start screen
// must paint from the smallest possible bundle (cold-start budget).
function named<T>(load: () => Promise<Record<string, unknown>>, key: string): T {
  return lazy(() => load().then((m) => ({ default: m[key] as React.ComponentType }))) as unknown as T;
}
const Toolbar = named<typeof import("./components/Toolbar").Toolbar>(() => import("./components/Toolbar"), "Toolbar");
const SeriesBrowser = named<typeof import("./viewer/SeriesBrowser").SeriesBrowser>(() => import("./viewer/SeriesBrowser"), "SeriesBrowser");
const StackViewport = named<typeof import("./viewer/StackViewport").StackViewport>(() => import("./viewer/StackViewport"), "StackViewport");
const VolumeWorkspace = named<typeof import("./viewer/VolumeWorkspace").VolumeWorkspace>(() => import("./viewer/VolumeWorkspace"), "VolumeWorkspace");
const ExportDialog = named<typeof import("./components/ExportDialog").ExportDialog>(() => import("./components/ExportDialog"), "ExportDialog");
const PacsDialog = named<typeof import("./components/PacsDialog").PacsDialog>(() => import("./components/PacsDialog"), "PacsDialog");
const UpdatePrompt = named<typeof import("./components/Updates").UpdatePrompt>(() => import("./components/Updates"), "UpdatePrompt");
const AccountSection = named<typeof import("./components/Account").AccountSection>(() => import("./components/Account"), "AccountSection");
const SendToRadLearnDialog = named<typeof import("./components/Account").SendToRadLearnDialog>(() => import("./components/Account"), "SendToRadLearnDialog");
const ReportDialog = named<typeof import("./components/ReportDialog").ReportDialog>(() => import("./components/ReportDialog"), "ReportDialog");
const ShortcutsDialog = named<typeof import("./components/Dialogs").ShortcutsDialog>(() => import("./components/Dialogs"), "ShortcutsDialog");
const CustomWindowDialog = named<typeof import("./components/Dialogs").CustomWindowDialog>(() => import("./components/Dialogs"), "CustomWindowDialog");
const DiscPickerDialog = named<typeof import("./components/Dialogs").DiscPickerDialog>(() => import("./components/Dialogs"), "DiscPickerDialog");
const MemoryHud = named<typeof import("./components/MemoryHud").MemoryHud>(() => import("./components/MemoryHud"), "MemoryHud");
const SettingsDialog = named<typeof import("./components/Dialogs").SettingsDialog>(() => import("./components/Dialogs"), "SettingsDialog");

type ScanState = { label: string; progress: ScanProgress | null } | null;

const cellKey = (i: number) => `cell-${i}`;
const viewportIdFor = (i: number) => `vp-${i}`;

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
  /** The hanging protocol applied on open, shown in the status bar. */
  const [hangingLabel, setHangingLabel] = useState<string | null>(null);
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
  const [view, setView] = useState<"grid" | VolumeMode>("grid");
  const [dialog, setDialog] = useState<null | "help" | "window" | "settings" | "disc" | "export" | "pacs" | "send">(null);
  /** Structured reports and key-image notes from the open study; the report being read. */
  const [documents, setDocuments] = useState<DicomDocument[]>([]);
  const [openReport, setOpenReport] = useState<DicomDocument | null>(null);
  const [handlesVersion, setHandlesVersion] = useState(0);
  const updater = useUpdater(settings.checkUpdates);
  const sync = useSyncStatus();
  const [, setTick] = useState(0);
  const browserFileInput = useRef<HTMLInputElement>(null);
  const browserFolderInput = useRef<HTMLInputElement>(null);
  const openSeq = useRef(0);
  /** True until the reader changes what is on screen; lets the final scan re-hang the primary series. */
  const autoHung = useRef(true);
  // Debug memory HUD: FLOWRAD_DEBUG=1 at launch, or Ctrl+Alt+Shift+M.
  const [hud, setHud] = useState(false);
  useEffect(() => {
    if (isTauri) void invoke<boolean>("debug_enabled").then((on) => on && setHud(true), () => undefined);
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.shiftKey && e.code === "KeyM") {
        e.preventDefault();
        setHud((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const bench = useRef<{
    enabled: boolean;
    t0: number;
    firstPaint?: number;
    marks: Record<string, number> & { interaction?: unknown; leak?: unknown; longTasks?: unknown; volumeStuck?: unknown };
    pendingVolume?: () => Promise<void>;
    volumeT0?: number;
  }>({
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
    if (isTauri) invoke<number>("startup_elapsed_ms").then((ms) => (bench.current.marks.windowReadyMs = ms), () => undefined);
    // The engine (≈3 MB of JS, WebGL, workers) is NOT loaded at idle: an idle
    // viewer must stay small. It warms on intent instead — an open dialog, a
    // drag over the window, a hover on a recent study — which is always
    // hundreds of ms before the first pixel is needed.
    // e2e paint probe (FLOWRAD_PROBE_AFTER_MS): a normal launch, then report
    // what every viewport actually shows. desktop/scripts/e2e-paint.py.
    if (isTauri)
      invoke<number | null>("probe_after_ms").then((ms) => {
        if (ms == null) return;
        window.setTimeout(() => {
          const viewports = [...document.querySelectorAll<HTMLElement>(".cs-viewport[data-has-series]")].map((el) => ({
            id: el.dataset.viewportId,
            maxLum: sampleCanvas(el),
          }));
          void invoke("probe_report", {
            report: {
              afterMs: ms,
              viewports,
              nonBlank: viewports.length > 0 && viewports.every((v) => (v.maxLum ?? 0) > 8),
              renderPath: paintHealth.last?.renderPath ?? null,
              visibility: document.visibilityState,
            },
          });
        }, ms);
      }, () => undefined);
    return onHandlesChanged(() => setHandlesVersion((v) => v + 1));
  }, []);

  // Idle footprint: with nothing open, ask the webview to give memory back
  // (WebView2's Low memory-usage target on Windows; a no-op elsewhere). The
  // moment a study starts opening it goes back to Normal.
  const nothingOpen = studies.length === 0 && scan == null;
  const nothingOpenRef = useRef(nothingOpen);
  nothingOpenRef.current = nothingOpen;
  useEffect(() => {
    if (!isTauri) return;
    const timer = window.setTimeout(
      () => void invoke("set_memory_mode", { low: nothingOpen }).catch(() => undefined),
      nothingOpen ? 1500 : 0
    );
    return () => window.clearTimeout(timer);
  }, [nothingOpen]);

  // Scroll feel is read by the StackScroll tool on every wheel / drag event.
  useEffect(() => {
    setScrollPreferences({
      slicesPerNotch: settings.scrollSlicesPerNotch,
      dragPixelsPerSlice: settings.scrollDragPx > 0 ? settings.scrollDragPx : null,
      acceleration: settings.scrollAcceleration,
    });
  }, [settings.scrollSlicesPerNotch, settings.scrollDragPx, settings.scrollAcceleration]);

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
  // Back in 2D: release the volume and return to the browsing cache budget,
  // so a study left open idles small (viewer/engine.ts).
  useEffect(() => {
    if (view !== "grid") return;
    const engine = enginePeek();
    if (!engine) return;
    leaveVolumeMemory(engine);
    // Give the freed volume back to the OS: a short Low memory-target pulse
    // makes WebView2 trim the renderer and GPU process (a no-op elsewhere).
    if (!isTauri) return;
    void invoke("set_memory_mode", { low: true }).catch(() => undefined);
    const timer = window.setTimeout(() => void invoke("set_memory_mode", { low: false }).catch(() => undefined), 2000);
    return () => window.clearTimeout(timer);
  }, [view]);

  // Hidden or minimised: hold the Low memory target until the reader is back.
  useEffect(() => {
    if (!isTauri) return;
    const onVisibility = () =>
      void invoke("set_memory_mode", { low: document.hidden || nothingOpenRef.current }).catch(() => undefined);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  /** Every file of the study on screen (images once each, plus its reports and key-image notes), for Send to PACS. */
  const sendableStudy = useMemo(() => {
    const study = active?.study;
    if (!study) return null;
    const files = new Set<string>();
    for (const series of study.series) for (const h of series.headers) if (h.fileName) files.add(h.fileName);
    for (const d of documents) if (!d.studyInstanceUid || d.studyInstanceUid === study.uid) files.add(d.fileName);
    return { label: study.description || "Untitled study", files: [...files] };
  }, [active?.study, documents]);
  const volumeSeries = active?.series.volumetric ? active.series : null;
  /** PET/CT pair from the active study: the active CT (or the largest CT volume) and the largest PET volume. */
  const fusionPair = useMemo(() => {
    const study = active?.study;
    if (!study) return null;
    const largest = (m: string) =>
      study.series.filter((s) => s.modality === m && s.volumetric).sort((a, b) => b.imageCount - a.imageCount)[0];
    const ct = active.series.modality === "CT" && active.series.volumetric ? active.series : largest("CT");
    const pt = active.series.modality === "PT" && active.series.volumetric ? active.series : largest("PT");
    return ct && pt ? { ct, pt } : null;
  }, [active]);
  const activeHandle = () => getHandle(cellKey(activeCell));
  // Latest values for the bench leak driver (it outlives this render).
  const activeHandleRef = useRef(activeHandle);
  activeHandleRef.current = activeHandle;

  // ───────────── open flow ─────────────
  const resetWorkspace = useCallback(() => {
    autoHung.current = true;
    setStudies([]);
    setCells([null]);
    setLayout({ rows: 1, cols: 1 });
    setActiveCell(0);
    setMaximized(null);
    setView("grid");
    setHangingLabel(null);
    setDocuments([]);
    setOpenReport(null);
  }, []);

  const finishOpen = useCallback(
    async (opened: OpenedSource, built: ViewerStudy[]) => {
      if (built.length === 0) return;
      if (settings.rememberHistory) {
        try {
          setHistory(await historyRecord(historyEntryFor(opened, built, new Date(), { includePatient: settings.indexPatients })));
        } catch {
          /* history is a convenience; never fail an open over it */
        }
      }
    },
    [settings.rememberHistory, settings.indexPatients]
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
    async (paths: string[], kindHint?: SourceKind, labelOverride?: string) => {
      if (!paths.length) return;
      // The engine is NOT started here, not even its module import: parsing
      // ~3 MB of Cornerstone on the main thread delays hanging the series and
      // its instant preview (measured: preview 165 → 540 ms). The viewport
      // starts it once the preview is on screen.
      if (!isTauri) {
        toast({ title: "Use Open files or drop files", description: "Opening by path needs the desktop app.", variant: "info" });
        return;
      }
      const seq = ++openSeq.current;
      const t0 = performance.now();
      bench.current.t0 = t0;
      bench.current.marks = { windowReadyMs: bench.current.marks.windowReadyMs ?? 0 };
      bench.current.firstPaint = undefined;
      resetWorkspace();
      const label = paths[0].split(/[\\/]/).filter(Boolean).pop() || paths[0];
      setScan({ label, progress: null });
      setGrowing(true);

      await initProtocol();
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
        const docs = result.documents ?? [];
        // Key-image notes become series of the images they select.
        const built = withKeyImageSeries(buildStudies(headers), docs);
        setDocuments(docs);
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
        // Progressive open hung whatever streamed in first. If the reader has
        // not touched anything yet, show the study's primary series instead.
        if (autoHung.current) {
          // Hanging protocol (CT / MR / projection / current vs prior) from the
          // viewer core; otherwise the study's primary series alone.
          const plan = hangingPlanFor(built);
          if (plan) {
            setLayout({ rows: plan.rows, cols: plan.cols });
            setCells(plan.cells);
            setActiveCell(0);
            setSyncScroll(plan.syncScroll);
            setHangingLabel(plan.label);
            if (plan.compare) {
              // Prior positions + offset land in the current study's frame.
              const prior = built.flatMap((st) => st.series).find((x) => x.uid === plan.compare!.priorSeries);
              if (prior?.imageIds[0]) setStackOffset(prior.imageIds[0], -plan.compare.priorOffsetMm);
            }
          } else {
            const study = built[0];
            const primary = study.series[primarySeriesIndex(study)]?.uid;
            if (primary) setCells((prev) => (prev[0] === primary ? prev : [primary, ...prev.slice(1)]));
          }
        } else {
          hangFirst(built);
        }
        const opened: OpenedSource = {
          key: sourceKey(paths),
          paths,
          kind: kindHint ?? result.kind,
          label: labelOverride ?? result.label,
        };
        setSource(opened);
        void finishOpen(opened, built);
        for (const w of result.warnings.slice(0, 2)) toast({ title: "Heads up", description: w, variant: "warning", duration: 8000 });
        bench.current.marks.scanDoneMs = performance.now() - t0;
        if (bench.current.enabled) {
          // Scan numbers are reported whether or not a frame ever paints (a
          // locked or minimised window may never paint); paint is its own field.
          // The shell also prints FLOWRAD_BENCH_SCAN the moment the scan ends,
          // and a watchdog line if nothing is reported at all.
          const report = async (paintTimedOut = false) => {
            const startup = await invoke<number>("startup_elapsed_ms").catch(() => 0);
            const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
            await benchReport({
              source: paths,
              files: result.inspected,
              images: built.reduce((n, s) => n + s.imageCount, 0),
              studies: built.length,
              series: built.reduce((n, s) => n + s.series.length, 0),
              skipped: result.skipped,
              cacheHits: result.cacheHits,
              usedDicomdir: result.usedDicomdir,
              rust: result.timings,
              ...bench.current.marks,
              firstImagePaintedMs: bench.current.firstPaint ?? null,
              paint: {
                firstPreviewMs: bench.current.marks.firstPreviewMs ?? null,
                firstImagePaintedMs: bench.current.firstPaint ?? null,
                timedOut: paintTimedOut,
                visibility: document.visibilityState,
                focused: document.hasFocus(),
              },
              viewport: paintHealth.last ?? null,
              ...(paintHealth.fallbackWhy ? { fallbackWhy: paintHealth.fallbackWhy } : {}),
              gpu: gpuInfo(),
              trimmedMb: Math.round(memoryStats.trimmedBytes / 1048576),
              ...cacheFacts(enginePeek()?.core, built[0]?.series[0]?.imageIds[0]),
              engineInitMs: engineTimings.initMs,
              // Relative to the open: when the engine started and was ready.
              engineStartMs: engineTimings.startAt != null ? Math.round(engineTimings.startAt - bench.current.t0) : undefined,
              engineSteps: engineTimings.steps,
              longTasks: { count: longTasks.count, maxMs: longTasks.maxMs, totalMs: longTasks.totalMs },
              engineReadyMs: engineTimings.readyAt != null ? Math.round(engineTimings.readyAt - bench.current.t0) : undefined,
              processUptimeMs: startup,
              ...(heap ? { jsHeapMb: Math.round(heap.usedJSHeapSize / 1048576) } : {}),
              ...((await invoke<boolean>("bench_pixels").catch(() => false))
                ? { pixels: await firstImagePixelStats(built).catch((e) => ({ error: String(e) })) }
                : {}),
            });
          };
          const benchView = await invoke<string | null>("bench_view").catch(() => null);
          if (benchView === "mpr" || benchView === "3d" || benchView === "fusion") {
            // Volume benchmark: switch view; the report fires when the volume is loaded.
            bench.current.pendingVolume = report;
            bench.current.volumeT0 = performance.now();
            setView(benchView);
            // A volume that never finishes must still report where it stuck.
            const volumeLimit = await invoke<number>("bench_paint_timeout_ms").catch(() => 20_000);
            window.setTimeout(() => {
              if (!bench.current.pendingVolume) return;
              bench.current.pendingVolume = undefined;
              void import("./viewer/VolumeWorkspace").then(({ volumeStages, volumeProgress }) => {
                bench.current.marks.volumeStuck = { stages: volumeStages, ...volumeProgress };
                void report(true);
              });
            }, volumeLimit * 2);
          } else {
            // Wait for the first pixel, but not forever.
            const limit = await invoke<number>("bench_paint_timeout_ms").catch(() => 20_000);
            const deadline = performance.now() + limit;
            const waitPaint = () => {
              if (bench.current.firstPaint != null && benchView === "leak") {
                // Feature on/off leak test: every feature opened and closed, twice.
                void (async () => {
                  const { runLeakCycle } = await import("./viewer/leakCycle");
                  bench.current.marks.leak = await runLeakCycle({
                    setView: (v) =>
                      new Promise<void>((resolve) => {
                        if (v === "grid") {
                          setView("grid");
                          return void window.setTimeout(resolve, 300);
                        }
                        const timeout = window.setTimeout(resolve, 60_000);
                        bench.current.pendingVolume = async () => {
                          window.clearTimeout(timeout);
                          resolve();
                        };
                        setView(v);
                      }),
                    setDialog: (d) => setDialog(d),
                    toggleCine: () => activeHandleRef.current()?.toggleCine(),
                    setTool: (t) => setLeftTool(t),
                  });
                  void report();
                })();
              } else if (bench.current.firstPaint != null && benchView === "interact") {
                // Frame-time profile of scroll / zoom / W-L on the main stack.
                void (async () => {
                  const engine = enginePeek();
                  const vp = engine?.renderingEngine.getViewport(viewportIdFor(0));
                  if (engine && vp) {
                    const { profileInteraction } = await import("./viewer/frameProfile");
                    bench.current.marks.interaction = await profileInteraction(engine.core, vp);
                  }
                  void report();
                })();
              } else if (bench.current.firstPaint != null) void report();
              else if (performance.now() > deadline) void report(true);
              else window.setTimeout(waitPaint, 20);
            };
            waitPaint();
          }
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
      const t0 = performance.now();
      bench.current.t0 = t0;
      bench.current.firstPaint = undefined;
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
        const scanDoneMs = performance.now() - t0;
        if (await benchEnabled()) {
          const waitPaint = () =>
            bench.current.firstPaint != null
              ? void benchReport({
                  path: "browser (lib/localDicomFiles)",
                  files: files.length,
                  images: built.reduce((n, s) => n + s.imageCount, 0),
                  scanDoneMs,
                  firstImagePaintedMs: bench.current.firstPaint,
                  engineInitMs: engineTimings.initMs,
                })
              : window.setTimeout(waitPaint, 20);
          waitPaint();
        }
      } catch (error) {
        setScan(null);
        toast({ title: "Those files could not be read", description: String(error), variant: "danger" });
      }
    },
    [hangFirst, resetWorkspace, toast]
  );

  const openDialog = useCallback(
    async (what: "files" | "folder" | "disc" | "zip" | "dicomdir" | "pacs") => {
      void getEngine();
      if (what === "pacs") {
        if (isTauri) setDialog("pacs");
        else toast({ title: "PACS needs the desktop app", variant: "info" });
        return;
      }
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
      else if (await benchEnabled()) {
        // Cold-start probe: report once the start screen has painted.
        requestAnimationFrame(() =>
          requestAnimationFrame(async () => {
            const ms = await invoke<number>("startup_elapsed_ms").catch(() => 0);
            const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
            // performance.now() counts from the webview's navigation start, so
            // ms − now() ≈ when the webview began loading the page: everything
            // before it is window + WebView2/WebKit start-up, after it is ours.
            const now = performance.now();
            await benchReport({
              coldStart: true,
              firstPaintMs: ms,
              webviewNavStartMs: Math.max(0, ms - now),
              jsStartMs: (window as unknown as { __jsStartMs?: number }).__jsStartMs,
              pageToPaintMs: now,
              windowReadyMs: bench.current.marks.windowReadyMs,
              ...(heap ? { jsHeapMb: Math.round(heap.usedJSHeapSize / 1048576) } : {}),
            });
          })
        );
      }
      off.push(await listen<string[]>("open-paths", (paths) => paths.length && openPaths(paths)));
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      off.push(
        await getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter") void getEngine();
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

  // Slice geometry for sync and the 3D cursor, straight from the header scan.
  useEffect(() => {
    for (const study of studies) for (const series of study.series) registerGeometry(series.imageIds, series.headers);
  }, [studies]);

  /** Sync on = link the visible stacks at what each shows now (PACS-style registration). */
  const toggleSync = useCallback(() => {
    setSyncScroll((on) => {
      if (!on) {
        void getEngine().then((engine) => {
          const ids = cells.flatMap((uid, i) => (uid && getHandle(cellKey(i)) ? [viewportIdFor(i)] : []));
          if (ids.length > 1) linkStacksAtCurrent(engine, ids, viewportIdFor(activeCell));
        });
      }
      return !on;
    });
  }, [cells, activeCell]);

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
      autoHung.current = false;
      setMaximized(null);
      setLayout({ rows, cols });
      setCells((prev) => hangSeries(prev, rows * cols, seriesOrder));
      setActiveCell((a) => Math.min(a, rows * cols - 1));
    },
    [seriesOrder]
  );

  const showSeries = useCallback(
    (uid: string, cell = activeCell) => {
      autoHung.current = false;
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

  const toggleView = useCallback(
    (next: VolumeMode) => {
      setView((current) => {
        if (current === next) return "grid";
        if (next === "fusion" ? !fusionPair : !volumeSeries) {
          toast({
            title: next === "fusion" ? "Fusion needs a CT and a PET volume" : "This series is not a volume",
            description:
              next === "fusion"
                ? "Open a study with a PET series and a CT series covering the same patient."
                : "MPR and 3D need evenly spaced, parallel slices (a CT or MR stack), not a scout, a multiframe clip or a single image.",
            variant: "info",
          });
          return current;
        }
        return next;
      });
    },
    [fusionPair, volumeSeries, toast]
  );

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
        case "escape": {
          // 1) a measurement being drawn → cancel it; 2) a tool other than
          // browsing → back to browsing; 3) then leave modes / full screen.
          const element = handle?.element;
          if (element && enginePeek()) {
            const cancelled = enginePeek()!.tools.cancelActiveManipulations(element);
            if (cancelled) return;
          }
          if (leftTool !== "StackScroll" && view === "grid") {
            setLeftTool("StackScroll");
            return;
          }
          if (view !== "grid") {
            setView("grid");
            return;
          }
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
          return toggleSync();
        case "toggleReferenceLines":
          return setReferenceLines((v) => !v);
        case "toggleBrowser":
          return setBrowserOpen((v) => !v);
        case "export":
          if (view !== "grid") return;
          return setDialog("export");
        case "mpr":
          return toggleView("mpr");
        case "volume3d":
          return toggleView("3d");
        case "fusion":
          return toggleView("fusion");
        case "undoAnnotation":
          return void getEngine().then(undoLastAnnotation);
        case "clearAnnotations":
          return void getEngine().then((e) => clearAnnotations(e));
        default:
          return;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [studies.length, leftTool, toggleSync, activeCell, presets, seriesOrder, activeSeriesUid, cells.length, maximized, distractionFree, view, openDialog, applyLayout, applyPreset, showSeries, toggleFullscreen, toggleView]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (dialog) return;
      // Tab switches series only from the image; on a control it still moves focus.
      if (e.key === "Tab" && target && target !== document.body && target.closest("button, a, [role=menuitem], [tabindex]")) return;
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

  const onPreview = useCallback(() => {
    if (bench.current.marks.firstPreviewMs == null) bench.current.marks.firstPreviewMs = performance.now() - bench.current.t0;
  }, []);

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
          prewarmEngine();
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
      {/* Browser-mode pickers only (the bench / plain-browser fallback). The
          desktop app opens through native dialogs, so these are not rendered
          there; where they are, they stay out of the accessibility tree
          (`hidden`): the visible Open buttons are the controls. */}
      {!isTauri && (
        <>
          <input
            ref={browserFileInput}
            type="file"
            multiple
            hidden
            aria-hidden="true"
            tabIndex={-1}
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
            hidden
            aria-hidden="true"
            tabIndex={-1}
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void openBrowserFiles(files);
            }}
          />
        </>
      )}

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
          onToggleSync={toggleSync}
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
          volumeView={view !== "grid"}
          onExport={view === "grid" ? () => setDialog("export") : undefined}
          onSend={sync.status.signedIn ? () => setDialog("send") : undefined}
          advanced={{
            mprAvailable: !!volumeSeries,
            fusionAvailable: !!fusionPair,
            view,
            onMpr: () => toggleView("mpr"),
            onVolume: () => toggleView("3d"),
            onFusion: () => toggleView("fusion"),
          }}
        />
      )}

      <main className="relative flex min-h-0 flex-1">
        {hasStudy ? (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center bg-imaging">
                <Spinner label="Loading viewer" />
              </div>
            }
          >
            {browserOpen && !distractionFree && (
              <aside className="w-[244px] shrink-0 border-r border-subtle bg-surface">
                <SeriesBrowser
                  studies={studies}
                  onScreen={cells}
                  activeSeriesUid={activeSeriesUid}
                  growing={growing}
                  compact={settings.compactSeries}
                  documents={documents}
                  onOpenReport={setOpenReport}
                  hidePatient={settings.hidePatient}
                  onOpenSeries={(uid) => showSeries(uid)}
                />
              </aside>
            )}
            {view !== "grid" && growing ? (
              // A volume is built once, from the complete series. While a cold
              // scan is still streaming files in, every batch changes the image
              // list (and the volume id), which used to restart the build on
              // every batch so it never drew (HP: MPR on an uncached 4,332-file
              // CT timed out).
              <section
                aria-label="Waiting for the study to finish loading"
                aria-busy="true"
                className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-imaging text-sm text-white/70"
              >
                <Spinner label={view === "3d" ? "Preparing 3D" : view === "fusion" ? "Preparing fusion" : "Preparing MPR"} />
                <p className="tabular-nums">
                  {scanProgress && scanProgress.total > 0
                    ? `Reading the study: ${scanProgress.read.toLocaleString()} of ${scanProgress.total.toLocaleString()} files`
                    : "Reading the study…"}
                </p>
                <Button variant="secondary" size="sm" onClick={() => setView("grid")}>
                  Back to 2D
                </Button>
              </section>
            ) : view !== "grid" && (view === "fusion" ? fusionPair : volumeSeries) ? (
              <VolumeWorkspace
                key={view}
                mode={view}
                series={view === "fusion" ? fusionPair!.ct : volumeSeries!}
                petSeries={view === "fusion" ? fusionPair!.pt : null}
                study={active?.study ?? null}
                showOverlay={overlay}
                onExit={() => setView("grid")}
                onVolumeReady={(t) => {
                  bench.current.marks.volumeLoadedMs = t.loadedMs;
                  bench.current.marks.volumeBuildMs = t.shellMs;
                  const pending = bench.current.pendingVolume;
                  bench.current.pendingVolume = undefined;
                  void pending?.();
                }}
              />
            ) : (
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
                    hidePatient={settings.hidePatient}
                    growing={growing}
                    onActivate={() => {
                      autoHung.current = false;
                      setActiveCell(i);
                    }}
                    onDropSeries={(dropped) => showSeries(dropped, i)}
                    onDoubleClick={() => cells.length > 1 && setMaximized((m) => (m == null ? i : null))}
                    onFirstPaint={onFirstPaint}
                    onPreview={onPreview}
                  />
                );
              })}
            </section>
            )}
          </Suspense>
        ) : (
          <StartScreen
            history={history}
            hidePatient={settings.hidePatient}
            onOpen={(w) => void openDialog(w)}
            onOpenPaths={(p, kind) => void openPaths(p, kind)}
            onForget={async (key) => setHistory(await historyRemove<HistoryEntry>(key))}
            onClearHistory={async () => {
              await historyClear();
              setHistory([]);
            }}
            version={version}
            dragging={dragging}
            onSettings={() => setDialog("settings")}
            onHelp={() => setDialog("help")}
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
          {hangingLabel && <span className="truncate text-secondary" title="Hanging protocol">{hangingLabel}</span>}
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

      <Suspense fallback={null}>
      {hud && <MemoryHud onClose={() => setHud(false)} />}
      {dialog === "help" && (
      <ShortcutsDialog open={dialog === "help"} onClose={() => setDialog(null)} />
      )}
      {dialog === "window" && (
      <CustomWindowDialog
        open={dialog === "window"}
        onClose={() => setDialog(null)}
        initial={{ ww: handle?.readout()?.ww, wc: handle?.readout()?.wc }}
        onApply={(ww, wc) => handle?.setVoi(ww, wc)}
      />
      )}
      {dialog === "disc" && (
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
      )}
      {dialog === "pacs" && (
      <PacsDialog
        open={dialog === "pacs"}
        onClose={() => setDialog(null)}
        onRetrieved={(folder, label) => void openPaths([folder], "folder", `PACS · ${label}`)}
        sendable={sendableStudy}
      />
      )}
      {dialog === "export" && (
      <ExportDialog
        open={dialog === "export"}
        onClose={() => setDialog(null)}
        handle={handle}
        series={active?.series ?? null}
        study={active?.study ?? null}
      />
      )}
      {openReport && <ReportDialog report={openReport} onClose={() => setOpenReport(null)} />}
      {dialog === "settings" && (
      <SettingsDialog
        open={dialog === "settings"}
        onClose={() => setDialog(null)}
        settings={settings}
        onChange={updateSettings}
        version={version}
        extra={
          <>
            <section className="py-3">
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Updates</h3>
              <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
                <span>
                  <span className="block text-sm font-medium text-primary">Check for updates on launch</span>
                  <span className="block text-xs text-muted">Asks before installing. Never updates silently.</span>
                </span>
                <input
                  type="checkbox"
                  checked={settings.checkUpdates}
                  onChange={(e) => updateSettings({ checkUpdates: e.target.checked })}
                  className="mt-1 h-4 w-4 accent-[rgb(var(--accent))]"
                />
              </label>
              <div className="flex items-center justify-between gap-4 py-1">
                <span className="text-xs text-muted">
                  {updater.status.state === "checking"
                    ? "Checking…"
                    : updater.status.state === "current"
                      ? "You have the latest version."
                      : updater.status.state === "available"
                        ? `Version ${updater.status.update.version} is available.`
                        : updater.status.state === "unavailable"
                          ? updater.status.reason
                          : ""}
                </span>
                <Button size="sm" variant="secondary" loading={updater.status.state === "checking"} onClick={() => void updater.check(true)}>
                  Check now
                </Button>
              </div>
            </section>
            <AccountSection status={sync.status} onChange={sync.setStatus} />
          </>
        }
      />
      )}
      {updater.prompt && (
      <UpdatePrompt update={updater.prompt} onClose={updater.dismiss} />
      )}
      {dialog === "send" && (
      <SendToRadLearnDialog
        open={dialog === "send"}
        onClose={() => setDialog(null)}
        status={sync.status}
        series={active?.series ?? null}
        study={active?.study ?? null}
      />
      )}
      </Suspense>
      {/* Keep the handles list fresh for the toolbar's cine state. */}
      <span hidden>{handlesVersion}</span>
    </div>
  );
}
