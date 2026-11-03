// FlowRad Viewer — the window.
//
// Owns: what is open (studies, source), how it is hung (layout, which series in
// which cell), the left-button tool, view toggles, and the open flow. The
// open flow is progressive: headers stream in from the Rust scanner, the first
// series hangs as soon as one image is known, and the stack grows in place.

import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Disc3, FolderOpen, ShieldCheck, X } from "lucide-react";
import { useToast } from "./toast";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import type { OrientationCommand, SliceStats, WindowPreset } from "@flowrad/viewer-core";
import { CollapsiblePanel } from "@/components/ui/CollapsiblePanel";
import { useSeriesPanel } from "@/components/viewer/useSeriesPanel";
import type { ExportKind } from "./components/ExportDialog";
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
  previewUrlFor,
  listen,
  pickFiles,
  pickFolder,
  scanPaths,
  settingsGet,
  settingsSet,
  takeLaunchPaths,
} from "./platform";
import { headersFromBrowserFiles } from "./browserSource";
import { buildStudiesSliced, describeSeries, formatDicomDate, primarySeriesIndex } from "./study";
import { historyEntryFor, priorsFor, sourceKey, type HistoryEntry } from "./history";
import type { DesktopHeader, OpenedSource, ScanProgress, SourceKind, ViewerSeries, ViewerStudy } from "./types";
import { DESKTOP_COMMANDS, keysForAction, resolveInput, resolveShortcut, type ShortcutAction } from "./shortcuts";
import { inputIndex, isMac, normalizeSpec, setLiveBindings } from "@flowrad/viewer-core/bindings";
import { StartScreen } from "./components/StartScreen";
import { useUpdater } from "./components/useUpdater";
import { useSyncStatus } from "./components/syncStatus";
import { DEFAULT_SETTINGS, type ViewerSettings } from "./settings";
import { setScrollPreferences } from "@flowrad/viewer-core";
import { hangingPlanFor } from "./hanging";
import { withKeyImageSeries, type DicomDocument } from "./documents";
import type { VolumeMode } from "./viewer/VolumeWorkspace";
import { engineViewportIds, getHandle, isNativeHandle, onHandlesChanged } from "./viewer/handles";
// Native viewports' annotation store (tiny, no engine): undo / redo / clear / F12.
import * as nativeAnnotations from "./native/annotations";
import {
  getStackOffset,
  clearAnnotations,
  engineTimings,
  enginePeek,
  leaveVolumeMemory,
  enterNativeVolumeMemory,
  getEngine,
  prewarmEngine,
  preloadEngineChunks,
  setGroupLeftTool,
  setReferenceSource,
  setScaleOverlay,
  linkStacksAtCurrent,
  registerGeometry,
  setStackOffset,
  setSynchronized,
  STACK_GROUP,
  annotationHistory,
  enterIdleMemory,
  leaveIdleMemory,
  type Engine,
} from "./viewer/engine";
import { windowPresetsFor } from "./viewer/presets";
import { hangSeries } from "./layout";
import { firstImagePixelStats } from "./viewer/pixelStats";
import { paintHealth, sampleCanvas } from "./viewer/paintCheck";
import { cacheFacts, gpuInfo, memoryStats } from "./viewer/memory";
import { longTasks, markPhase } from "./perfWatch";
import { onActivity } from "./activity";
import { nativeEnabled, nativeKnown, settleNativeAtStart, warmNative } from "./native/nativeLayout";
import { insidePicker, onSeriesDrop, onSeriesToMonitor, setMonitorSource, useSeriesDrag } from "./viewer/seriesDrag";
import {
  announceClosing,
  currentMonitorName,
  isSecondaryWindow,
  listMonitors,
  monitorsAvailable,
  onHandoffChanged,
  onWindowMessage,
  openViewerWindow,
  postToWindows,
  takeHandoff,
  windowId,
  type WindowHandoff,
} from "./multiWindow";
import { useCrossWindow } from "./viewer/useCrossWindow";
import { preloadable } from "./lazyView";
import { MonitorBadge, MonitorPicker } from "./components/MonitorPicker";
import { setToolCursor } from "./viewer/toolCursor";
import type { VoiceProgress, VoiceSession, VoiceState } from "@/components/viewer/voice/voiceSession";
import { VoiceStatus } from "@/components/viewer/voice/VoiceStatus";
import {
  monitorColor,
  nextMonitor,
  placeArrangement,
  imageMenu,
  thumbnailMenu,
  type MenuCommand,
  type MonitorInfo,
  type VoiceAction,
  type WindowArrangement,
} from "@flowrad/viewer-core";

// Everything the start screen does not need loads on demand: the start screen
// must paint from the smallest possible bundle (cold-start budget).
function named<T>(load: () => Promise<Record<string, unknown>>, key: string): T {
  return lazy(() => load().then((m) => ({ default: m[key] as React.ComponentType }))) as unknown as T;
}
// The study view (toolbar, series browser, viewports) is fetched when an open
// starts (`preloadStudyView`), in parallel with the scan, not when the first
// series renders (lazyView.tsx: that was a chunk waterfall before the first image).
const Toolbar = preloadable(() => import("./components/Toolbar").then((m) => m.Toolbar));
const SeriesBrowser = preloadable(() => import("./viewer/SeriesBrowser").then((m) => m.SeriesBrowser));
const StackViewport = preloadable(() => import("./viewer/StackViewport").then((m) => m.StackViewport));
// Phase 2 (FLOWRAD_NATIVE=1): monochrome single-frame series are drawn by the
// native renderer; everything else stays on the JS viewer (per series).
const NativeStackViewport = preloadable(() => import("./native/NativeStackViewport").then((m) => m.default));
/** Start fetching the study view's chunks (idempotent; failures retry on render). */
function preloadStudyView(): Promise<unknown> {
  return Promise.all([Toolbar, SeriesBrowser, StackViewport, NativeStackViewport].map((v) => v.preload().catch(() => undefined)));
}
const Native3DView = named<typeof import("./viewer/Native3DView").Native3DView>(() => import("./viewer/Native3DView"), "Native3DView");
const NativePlaneView = named<typeof import("./viewer/NativePlaneView").NativePlaneView>(() => import("./viewer/NativePlaneView"), "NativePlaneView");
const NativeMprView = named<typeof import("./viewer/NativeMprView").NativeMprView>(() => import("./viewer/NativeMprView"), "NativeMprView");
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
const DicomTagsDialog = named<typeof import("@/components/viewer/DicomTagsDialog").DicomTagsDialog>(() => import("@/components/viewer/DicomTagsDialog"), "DicomTagsDialog");
const MemoryHud = named<typeof import("./components/MemoryHud").MemoryHud>(() => import("./components/MemoryHud"), "MemoryHud");
const SettingsDialog = named<typeof import("./components/Dialogs").SettingsDialog>(() => import("./components/Dialogs"), "SettingsDialog");

type ScanState = { label: string; progress: ScanProgress | null } | null;

const cellKey = (i: number) => `cell-${i}`;
/** Tools in the right-click menu, in order. */
const MENU_TOOLS = [
  { id: "StackScroll", label: "Scroll" },
  { id: "WindowLevel", label: "Window / level" },
  { id: "Zoom", label: "Zoom" },
  { id: "Pan", label: "Pan" },
  { id: "Length", label: "Length" },
  { id: "Angle", label: "Angle" },
  { id: "EllipticalROI", label: "Ellipse ROI" },
  { id: "RectangleROI", label: "Rectangle ROI" },
  { id: "Probe", label: "Pixel probe" },
  { id: "ArrowAnnotate", label: "Arrow / text" },
  { id: "Eraser", label: "Eraser" },
];
const viewportIdFor = (i: number) => `vp-${i}`;

/** Paint health of the volume panes (MPR / 3D), from their per-pane max luminance. */
function volumePaneHealth(panes: unknown): { maxLum: number; nonBlank: boolean; renderPath: string; panes: Record<string, number> } | null {
  if (!panes || typeof panes !== "object") return null;
  const values = Object.values(panes as Record<string, number>).filter((v) => typeof v === "number");
  if (!values.length) return null;
  return {
    maxLum: Math.min(...values),
    nonBlank: values.every((v) => v > 8),
    renderPath: "native-volume",
    panes: panes as Record<string, number>,
  };
}

const firstImageOf = (fullRes?: number | null, engine?: number | null): number | null => {
  const ms = Math.min(fullRes ?? Infinity, engine ?? Infinity);
  return Number.isFinite(ms) ? ms : null;
};

/** The native viewport's first show, as `onFirstPaint` passes it (bench timeline). */
type FirstNativeShow = { cached: boolean; decodeMs: number; frameMs: number; totalMs: number; acquireMs?: number };

/** Series the native renderer draws (P2.2): monochrome, one frame per file. */
function nativeCapable(series: { multiframe?: boolean; headers: readonly { photometricInterpretation?: string }[] }): boolean {
  if (series.multiframe || series.headers.length === 0) return false;
  const pi = (series.headers[0].photometricInterpretation ?? "MONOCHROME2").toUpperCase();
  return pi.startsWith("MONOCHROME");
}

/**
 * Whether this window renders natively; false at once outside Tauri. Waits
 * for the answer without asking: on Windows the GPU (and so the answer) comes
 * with the first open, and nothing that waits here is needed before one.
 */
function whenNativeKnown(): Promise<boolean> {
  return isTauri ? nativeKnown() : Promise.resolve(false);
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
  /** The hanging protocol applied on open, shown in the status bar. */
  const [hangingLabel, setHangingLabel] = useState<string | null>(null);
  const [cells, setCells] = useState<(string | null)[]>([null]);
  const [activeCell, setActiveCell] = useState(0);
  const [maximized, setMaximized] = useState<number | null>(null);
  // Native renderer on (FLOWRAD_NATIVE=1 and the GPU surface is up).
  // Native renderer: null until known (Tauri asks Rust once at start), so a
  // viewport is never first mounted on the JS path and then swapped.
  const [nativeMode, setNativeMode] = useState<boolean | null>(isTauri ? null : false);
  const native = nativeMode === true;
  const nativeRef = useRef(false);
  /**
   * The JS (Cornerstone) engine for App-level wiring: tools, sync, annotation
   * visibility, linked windows. In native mode it is NOT started here — its
   * import + init cost ~350 ms of main thread right when the first image is
   * due, plus a WebGL context and a decode worker — only used once a JS-path
   * viewport (colour / multi-frame fallback) has started it itself.
   */
  const withEngine = useCallback((fn: (engine: Engine) => void) => {
    // Until Rust has answered whether this window is native, wait for it:
    // an open right after launch must not start the engine "just in case".
    void whenNativeKnown().then((on) => {
      if (!on) {
        void getEngine().then(fn);
        return;
      }
      const engine = enginePeek();
      if (engine) fn(engine);
    });
  }, []);
  /**
   * A study is about to open (Open dialog, drag over the window, the preview
   * up): warm its renderer. Native: the GPU device (built on demand on
   * Windows, so the empty app holds none). JS: the engine.
   */
  const prewarmJsEngine = useCallback(() => {
    if (!isTauri) return void getEngine();
    void warmNative().then((on) => !on && void getEngine());
  }, []);
  /**
   * Start screen, pointer on a recent study or a disc: native mode builds the
   * GPU (released again if no study follows); the JS path compiles the engine.
   */
  const warmForOpen = useCallback(() => {
    if (!isTauri) return prewarmEngine();
    void warmNative().then((on) => !on && prewarmEngine());
  }, []);
  useEffect(() => {
    if (!isTauri) return;
    settleNativeAtStart();
    void nativeKnown().then((on) => {
      nativeRef.current = on;
      setNativeMode(on);
      if (on) document.documentElement.classList.add("native-transparent");
    });
  }, []);
  const [leftTool, setLeftTool] = useState("StackScroll");
  const [overlay, setOverlay] = useState(true);
  const [annotationsVisible, setAnnotationsVisible] = useState(true);
  const [syncScroll, setSyncScroll] = useState(false);
  const [referenceLines, setReferenceLines] = useState(false);
  /** Window/level and zoom/pan follow the active viewport across the visible ones. */
  const [syncVoi, setSyncVoi] = useState(false);
  const [syncZoom, setSyncZoom] = useState(false);
  // Series panel: collapses to a rail (Mod+B, chevron, right-click), remembered per device.
  const seriesPanel = useSeriesPanel();
  const [distractionFree, setDistractionFree] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState<"grid" | VolumeMode>("grid");
  const [dialog, setDialog] = useState<null | "help" | "window" | "settings" | "disc" | "export" | "pacs" | "send">(null);
  /** Structured reports and key-image notes from the open study; the report being read. */
  const [documents, setDocuments] = useState<DicomDocument[]>([]);
  /** The bench's way to build a one-series handoff (set once handoffFor exists). */
  const benchHandoffRef = useRef<(uid: string) => WindowHandoff>(() => ({ sourceLabel: "", rows: 1, cols: 1, cells: [], activeCell: 0, links: { scroll: true, voi: false, zoom: false, referenceLines: false } }));
  /** What was opened, for handing to another window: scanned headers (desktop) or the files (browser). */
  const rawOpen = useRef<{ headers?: DesktopHeader[]; documents?: unknown[]; files?: File[] }>({});
  const [openReport, setOpenReport] = useState<DicomDocument | null>(null);
  const [handlesVersion, setHandlesVersion] = useState(0);
  const updater = useUpdater(settings.checkUpdates, scan !== null);
  const sync = useSyncStatus();
  const [, setTick] = useState(0);
  const browserFileInput = useRef<HTMLInputElement>(null);
  const browserFolderInput = useRef<HTMLInputElement>(null);
  const openSeq = useRef(0);
  /** True until the reader changes what is on screen; lets the final scan re-hang the primary series. */
  const autoHung = useRef(true);
  // Debug memory HUD: FLOWRAD_DEBUG=1 at launch, or Ctrl+Alt+Shift+M.
  const [hud, setHud] = useState(false);
  // Series dragged from the list (pointer-driven, seriesDrag.ts).
  const seriesDrag = useSeriesDrag();
  /** Bench: volume views start with this slab (FLOWRAD_BENCH_SLAB=mip:20). */
  const [benchSlab, setBenchSlab] = useState<{ mode: "off" | "mip" | "minip" | "avg"; mm: number } | undefined>();
  useEffect(() => {
    if (!isTauri) return;
    void invoke<string | null>("bench_slab").then((v) => {
      const [mode, mm] = (v ?? "").split(":");
      if (mode === "mip" || mode === "minip" || mode === "avg") setBenchSlab({ mode, mm: Number(mm) || 10 });
    }, () => undefined);
  }, []);
  /** Quick reformats by cell: that cell shows one native plane of its series. */
  const [reformats, setReformats] = useState<Record<number, { uid: string; plane: "axial" | "coronal" | "sagittal" }>>({});
  /** Slab shortcut (T, Ctrl+[ ]) for the active reformat; `seq` re-fires the same command. */
  const [slabCommand, setSlabCommand] = useState<{ mode?: "off" | "mip" | "minip" | "avg"; deltaMm?: number; mm?: number; seq: number; cell?: number } | undefined>();
  /** Each reformat's slab as shown, for the right-click menu's checks. */
  const [cellSlabs, setCellSlabs] = useState<Record<number, { mode: "off" | "mip" | "minip" | "avg"; mm: number }>>({});
  const slabCycle = useRef<"off" | "mip" | "minip" | "avg">("off");
  /** Slab a voice command asked for before a reformat was open. */
  const [voiceSlab, setVoiceSlab] = useState<{ mode: "off" | "mip" | "minip" | "avg"; mm: number } | undefined>();
  /** Series the native MPR cannot decode (falls back to the GPU MPR). */
  const [nativeMprUnsupported, setNativeMprUnsupported] = useState<string | null>(null);
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
    marks: Record<string, number> & { nativeTools?: unknown; interaction?: unknown; leak?: unknown; longTasks?: unknown; volumeStuck?: unknown; mprPanes?: unknown; vrPanes?: unknown; nativeFirst?: unknown; mprSlab?: unknown; reformat?: unknown; multiWindow?: unknown; voice?: unknown; steps?: unknown; hooks?: unknown; openClose?: unknown };
    pendingVolume?: () => Promise<void>;
    /** Open/close rounds (BENCH_VIEW=openclose): the round now open. Survives the re-open's mark reset. */
    openCloseRound?: number;
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
      // ≤ 0.8.1 kept re-mapped keys as `shortcuts` (id → spec): carry them over once.
      setLiveBindings(merged.bindings ?? {});
      setSettings(merged);
      setOverlay(merged.showOverlay);
      if (merged.shortcuts && Object.keys(merged.shortcuts).length && !Object.keys(merged.bindings ?? {}).length) {
        // Rare, once: loaded only for a reader upgrading with re-mapped keys.
        void import("@flowrad/viewer-core/bindings/storage").then(({ migrateShortcutOverrides }) => {
          const bindings = migrateShortcutOverrides(merged.shortcuts, DESKTOP_COMMANDS);
          setLiveBindings(bindings);
          setSettings((cur) => ({ ...cur, bindings, shortcuts: {} }));
          void settingsSet<ViewerSettings>({ bindings, shortcuts: {} });
        });
      }
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
  const viewRef = useRef(view);
  viewRef.current = view;
  const nothingOpenRef = useRef(nothingOpen);
  nothingOpenRef.current = nothingOpen;
  useEffect(() => {
    if (!isTauri) return;
    const timer = window.setTimeout(() => {
      // A study was just closed: collect its headers, series and view state
      // now (the start screen may sit idle for a long while), then let
      // WebView2 trim. `gc` exists because the app starts V8 with
      // --expose-gc (tauri.conf.json); absent elsewhere.
      if (nothingOpen) (globalThis as { gc?: () => void }).gc?.();
      void invoke("set_memory_mode", { low: nothingOpen }).catch(() => undefined);
    }, nothingOpen ? 1500 : 0);
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
    // Bindings apply to every viewport, tooltip and sheet at once.
    if (patch.bindings) setLiveBindings(patch.bindings);
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
    markPhase(`view: ${view}`);
    const engine = enginePeek();
    if (view !== "grid") {
      // Native MPR / 3D: the 2D cache and workers are not needed meanwhile,
      // and the webview only shows images Rust renders: hold WebView2 at its
      // Low memory target for the whole view (3D warm peak was 1.28 GB on the HP).
      if (isTauri && settings.nativeMpr && view !== "fusion") {
        if (engine) enterNativeVolumeMemory(engine);
        void invoke("set_memory_mode", { low: true }).catch(() => undefined);
      }
      return;
    }
    if (engine) leaveVolumeMemory(engine);
    // Give the freed volume back to the OS: a short Low memory-target pulse
    // makes WebView2 trim the renderer and GPU process (a no-op elsewhere).
    if (!isTauri) return;
    void invoke("set_memory_mode", { low: true }).catch(() => undefined);
    const timer = window.setTimeout(() => void invoke("set_memory_mode", { low: false }).catch(() => undefined), 2000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Idle with a study open: after 10 s without input, ask WebView2 to trim
  // (Low memory target: renderer and GPU process give memory back; HP idle
  // with a CT open was 0.97 GB). Any input restores Normal at once.
  useEffect(() => {
    if (!isTauri || nothingOpen) return;
    let low = false;
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      if (low) {
        low = false;
        void invoke("set_memory_mode", { low: false }).catch(() => undefined);
        const engine = enginePeek();
        if (engine) leaveIdleMemory(engine);
      }
      timer = window.setTimeout(() => {
        // Never while a volume view or cine is busy: only the 2D grid idles.
        if (viewRef.current !== "grid" || activeHandleRef.current()?.cine().playing) return arm();
        low = true;
        const engine = enginePeek();
        if (engine) enterIdleMemory(engine);
        // trim: Rust's decoded-slice cache keeps the slices around this one.
        void invoke("set_memory_mode", { low: true, trim: true }).catch(() => undefined);
      }, 10_000);
    };
    const events = ["pointerdown", "pointermove", "wheel", "keydown"] as const;
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    // Frames rendered and series loading count too (scripted, voice, cine,
    // linked windows): only a viewer where nothing changes for 10 s is idle.
    const offActivity = onActivity(arm);
    arm();
    return () => {
      window.clearTimeout(timer);
      offActivity();
      events.forEach((e) => window.removeEventListener(e, arm));
      if (low) void invoke("set_memory_mode", { low: false }).catch(() => undefined);
    };
  }, [nothingOpen]);

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
      // Start on the first image now, while the viewport mounts. Native
      // mode: Rust decodes the slice the native viewport shows first (index
      // 0) into its store, so `native_cell_series` only uploads and draws (no
      // PNG preview: nothing would show it). JS path: the instant preview,
      // whose <img> then comes from the webview's memory cache.
      const head = first?.headers[0];
      if (head && isTauri) {
        void nativeEnabled().then((on) => {
          if (on) return void invoke("native_warm", { fileIds: [head.fileId] }).catch(() => undefined);
          try {
            const img = new Image();
            img.decoding = "async";
            img.src = previewUrlFor(head.fileId);
          } catch {
            /* protocol not ready: the viewport asks itself */
          }
        });
      }
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
      // Build the GPU while the scan runs (on Windows it is not built at
      // start-up, or was released after the last study closed); the first
      // viewport finds it ready. A no-op while it is up.
      void warmNative();
      const seq = ++openSeq.current;
      const t0 = performance.now();
      bench.current.t0 = t0;
      bench.current.marks = { windowReadyMs: bench.current.marks.windowReadyMs ?? 0 };
      bench.current.firstPaint = undefined;
      // The study view's chunks load while Rust scans (they were fetched one
      // after another once the first series hung: the first image waited on them).
      void preloadStudyView().then(() => {
        if (seq === openSeq.current) bench.current.marks.viewChunksMs = performance.now() - t0;
      });
      resetWorkspace();
      const label = paths[0].split(/[\\/]/).filter(Boolean).pop() || paths[0];
      setScan({ label, progress: null });
      setGrowing(true);

      await initProtocol();
      const acc = new Map<string, DesktopHeader>();
      let timer = 0;
      let firstShown = false;
      // Grouping is time-sliced (`buildStudiesSliced`): on the HP's 10,310-image,
      // 242-series MRI it was one 66-75 ms main-thread task. One progressive
      // rebuild runs at a time; batches that land meanwhile ask for another.
      // The final build (scan done) supersedes any rebuild still in flight.
      let building = false;
      let rebuildAgain = false;
      let scanDone = false;
      const marks = bench.current.marks;
      const groupStats = (s: SliceStats) => {
        marks.groupSlices = (marks.groupSlices ?? 0) + s.slices;
        marks.groupMaxSliceMs = Math.max(marks.groupMaxSliceMs ?? 0, s.maxSliceMs);
        marks.groupBusyMs = s.busyMs;
      };
      const rebuild = async () => {
        timer = 0;
        if (seq !== openSeq.current || scanDone) return;
        if (building) {
          rebuildAgain = true;
          return;
        }
        building = true;
        markPhase("study: group series");
        const built = await buildStudiesSliced([...acc.values()], {
          isCancelled: () => seq !== openSeq.current || scanDone,
          onStats: groupStats,
        });
        building = false;
        if (!built || seq !== openSeq.current || scanDone) return;
        // After the first series is up, later batches re-render at low
        // priority (time-sliced) instead of one long task per batch.
        if (firstShown) startTransition(() => setStudies(built));
        else setStudies(built);
        if (!firstShown && built.length) {
          firstShown = true;
          bench.current.marks.firstSeriesHungMs = performance.now() - t0;
          // The study is on screen and its preview is loading: compile the
          // engine meanwhile (not at page load: on a cold disk that delayed the preview).
          // Native mode: the JS engine is only for series the native path
          // does not draw; it loads on demand then, not up front.
          if (!isTauri) preloadEngineChunks();
          else void nativeEnabled().then((on) => !on && preloadEngineChunks());
          setScan(null); // progressive: the viewer takes over, progress moves to the status bar
          hangFirst(built);
        }
        // Batches that landed while this one was grouping: the next rebuild
        // (right away until a series is up, then at the usual 250 ms pace).
        if (rebuildAgain) {
          rebuildAgain = false;
          if (!timer) timer = window.setTimeout(rebuild, firstShown ? 250 : 0);
        }
      };

      try {
        bench.current.marks.scanCalledMs = performance.now() - t0;
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
            if (!firstShown) void rebuild();
            else if (!timer) timer = window.setTimeout(rebuild, 250);
          },
        });
        if (seq !== openSeq.current) return;
        window.clearTimeout(timer);
        scanDone = true; // cancels a progressive rebuild still in flight
        const headers = result.headers.map((h) => ({ ...h, baseImageId: `wadouri:${imageUrlFor(h.fileId)}` }));
        const docs = result.documents ?? [];
        markPhase("study: group series");
        const grouped = await buildStudiesSliced(headers, {
          isCancelled: () => seq !== openSeq.current,
          onStats: groupStats,
        });
        if (!grouped || seq !== openSeq.current) return;
        // Key-image notes become series of the images they select.
        const built = withKeyImageSeries(grouped, docs);
        rawOpen.current = { headers, documents: docs };
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
          // The complete series is sorted now: slice 0 of each hung series is
          // what its viewport asks for next. Decode it while React re-renders.
          if (nativeRef.current) {
            const study = built[0];
            const hung = plan ? plan.cells : [study?.series[primarySeriesIndex(study)]?.uid];
            const all = built.flatMap((st) => st.series);
            const ids = hung.flatMap((uid) => {
              const sr = uid ? all.find((x) => x.uid === uid) : undefined;
              return sr && nativeCapable(sr) ? [sr.headers[0].fileId] : [];
            });
            if (ids.length) void invoke("native_warm", { fileIds: ids }).catch(() => undefined);
          }
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
              // The open on the process clock (ms since start), to line it up
              // with the scan command's own timeline (rust.enteredAtMs …).
              openAtProcessMs: startup ? Math.round(startup - (performance.now() - t0)) : null,
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
              // Phase 2: the native renderer's state and the first native
              // viewport's rect (CSS px), for the e2e's screen grab.
              ...(nativeRef.current
                ? {
                    native: await invoke("native_status").catch(() => null),
                    nativeCell: (() => {
                      const r = document.querySelector("[data-native-viewport]")?.getBoundingClientRect();
                      return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
                    })(),
                    nativeStore: await invoke("native_store_stats").catch(() => null),
                  }
                : {}),
              // First full-resolution slice on screen at the file's window:
              // Rust's full-res preview or the engine's paint, whichever first.
              firstImageMs: firstImageOf(bench.current.marks.firstFullResMs, bench.current.firstPaint),
              firstImageSource:
                bench.current.marks.firstFullResMs != null && !((bench.current.firstPaint ?? Infinity) < bench.current.marks.firstFullResMs)
                  ? "full-res preview"
                  : "engine",
              paint: {
                firstPreviewMs: bench.current.marks.firstPreviewMs ?? null,
                firstImagePaintedMs: bench.current.firstPaint ?? null,
                timedOut: paintTimedOut,
                visibility: document.visibilityState,
                focused: document.hasFocus(),
              },
              // `viewport` = what is on screen. In a volume bench that is the
              // MPR / 3D panes: the 2D stack check was cut short when the view
              // switched (its canvas unmounted), and reported "blank, maxLum 0"
              // although the 3D pane had painted. The 2D check stays as stackViewport.
              viewport:
                volumePaneHealth(bench.current.marks.vrPanes ?? bench.current.marks.mprPanes) ??
                paintHealth.last ??
                // Native 2D: drawn by the GPU renderer; blank checks are the e2e's screen grab.
                (nativeRef.current && document.querySelector("[data-native-viewport]") ? { renderPath: "native", nonBlank: true, expectVisible: true, maxLum: 255, checkedBy: "screen grab (e2e-native.py), not a canvas readback" } : null),
              stackViewport: paintHealth.last ?? null,
              ...(paintHealth.fallbackWhy ? { fallbackWhy: paintHealth.fallbackWhy } : {}),
              gpu: gpuInfo(),
              trimmedMb: Math.round(memoryStats.trimmedBytes / 1048576),
              ...cacheFacts(enginePeek()?.core, built[0]?.series[0]?.imageIds[0]),
              engineInitMs: engineTimings.initMs,
              // Relative to the open: when the engine started and was ready.
              engineStartMs: engineTimings.startAt != null ? Math.round(engineTimings.startAt - bench.current.t0) : undefined,
              engineSteps: engineTimings.steps,
              longTasks: { count: longTasks.count, maxMs: longTasks.maxMs, totalMs: longTasks.totalMs, recent: longTasks.recent },
              engineReadyMs: engineTimings.readyAt != null ? Math.round(engineTimings.readyAt - bench.current.t0) : undefined,
              processUptimeMs: startup,
              ...(heap ? { jsHeapMb: Math.round(heap.usedJSHeapSize / 1048576) } : {}),
              ...((await invoke<boolean>("bench_pixels").catch(() => false))
                ? { pixels: await firstImagePixelStats(built).catch((e) => ({ error: String(e) })) }
                : {}),
            });
          };
          const benchView = await invoke<string | null>("bench_view").catch(() => null);
          const benchReformat = await invoke<string | null>("bench_reformat").catch(() => null);
          if (benchReformat === "coronal" || benchReformat === "sagittal" || benchReformat === "axial") {
            // Quick reformat benchmark: the largest volume, one plane in cell 0;
            // the report fires when that plane is on screen.
            const target = built
              .flatMap((st) => st.series)
              .filter((sr) => sr.volumetric)
              .sort((a, b) => b.imageIds.length - a.imageIds.length)[0];
            if (target) {
              bench.current.pendingVolume = report;
              autoHung.current = false;
              setCells((prev) => prev.map((v, i) => (i === 0 ? target.uid : v)));
              setActiveCell(0);
              setReformats({ 0: { uid: target.uid, plane: benchReformat } });
              bench.current.marks.volumeSeriesImages = target.imageIds.length;
              const limit = await invoke<number>("bench_paint_timeout_ms").catch(() => 20_000);
              window.setTimeout(() => {
                if (!bench.current.pendingVolume) return;
                bench.current.pendingVolume = undefined;
                void report(true);
              }, limit * 2);
              return;
            }
          }
          if (benchView === "mpr" || benchView === "3d" || benchView === "fusion") {
            // Volume benchmark: switch view; the report fires when the volume is loaded.
            bench.current.pendingVolume = report;
            bench.current.volumeT0 = performance.now();
            // A multi-series study (MRI): use its largest volumetric series.
            const target = built
              .flatMap((st) => st.series)
              .filter((sr) => sr.volumetric)
              .sort((a, b) => b.imageIds.length - a.imageIds.length)[0];
            if (target && benchView !== "fusion") {
              autoHung.current = false;
              setCells((prev) => prev.map((v, i) => (i === 0 ? target.uid : v)));
              setActiveCell(0);
              bench.current.marks.volumeSeriesImages = target.imageIds.length;
            }
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
                  const rounds = await invoke<number>("bench_leak_rounds").catch(() => 2);
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
                  }, { rounds });
                  void report();
                })();
              } else if (bench.current.firstPaint != null && benchView === "multiwindow") {
                // A second viewer window: opens, paints, obeys, closes, frees its memory.
                void (async () => {
                  const { runWindowCycle } = await import("./viewer/windowCycle");
                  const all = built.flatMap((st) => st.series).filter((x) => x.imageCount > 1);
                  if (all.length) {
                    setSyncScroll(true);
                    bench.current.marks.multiWindow = await runWindowCycle(
                      { open: (uid) => openViewerWindow(benchHandoffRef.current(uid), null) },
                      [all[0].uid, (all[1] ?? all[0]).uid]
                    );
                  }
                  void report();
                })();
              } else if (bench.current.firstPaint != null && benchView === "interact") {
                // Frame-time profile of scroll / zoom / W-L on the main stack.
                void (async () => {
                  const engine = enginePeek();
                  const vp = engine?.renderingEngine.getViewport(viewportIdFor(0));
                  if (nativeRef.current && document.querySelector("[data-native-viewport]")) {
                    // Native viewport (the default after the cutover): same profile, same gates.
                    const { profileNativeInteraction } = await import("./native/benchInteract");
                    bench.current.marks.interaction = await profileNativeInteraction(cellKey(0));
                  } else if (engine && vp) {
                    const { profileInteraction } = await import("./viewer/frameProfile");
                    bench.current.marks.interaction = await profileInteraction(engine.core, vp);
                  }
                  void report();
                })();
              } else if (bench.current.firstPaint != null && benchView === "native-tools") {
                // P2.3 e2e: draw with the real tools through real pointer
                // events on the native viewport, then report what they measured.
                void (async () => {
                  const { driveNativeTools } = await import("./native/benchTools");
                  bench.current.marks.nativeTools = await driveNativeTools(setLeftTool);
                  void report();
                })();
              } else if (bench.current.firstPaint != null && benchView === "voice") {
                // Voice e2e in the built app, under its production CSP.
                void (async () => {
                  const { runVoiceBench } = await import("./voiceBench");
                  bench.current.marks.voice = await runVoiceBench((a) => voiceAction.current(a));
                  void report();
                })();
              } else if (bench.current.firstPaint != null && benchView === "openclose") {
                // Open/close rounds (bench.mjs `openclose`): like `close`, but
                // the same study is re-opened through the app's own open path
                // after each close, N rounds (FLOWRAD_LEAK_ROUNDS). Each round
                // reports open, holds BENCH_CLOSE_AFTER_MS, closes (Home),
                // reports closed, holds again, re-opens; the bench samples the
                // whole tree's private bytes at each report.
                void (async () => {
                  const round = (bench.current.openCloseRound ?? 0) + 1;
                  bench.current.openCloseRound = round;
                  const rounds = await invoke<number>("bench_leak_rounds").catch(() => 2);
                  const hold = await invoke<number>("bench_close_after_ms").catch(() => 20_000);
                  bench.current.marks.openClose = { round, rounds, holdMs: hold };
                  await report();
                  window.setTimeout(() => {
                    goHomeRef.current();
                    void benchReport({ closed: true, openClose: { round, rounds }, closedAtMs: Math.round(performance.now() - t0) });
                    if (round < rounds) window.setTimeout(() => void openPathsRef.current(paths), hold);
                  }, hold);
                })();
              } else if (bench.current.firstPaint != null && benchView === "steps") {
                // Scripted interaction pass: scroll, W/L, rotate, timed per step.
                void (async () => {
                  const { runStepsPass, nativeDriver, engineDriver } = await import("./benchSteps");
                  const engine = enginePeek();
                  const vp = engine?.renderingEngine.getViewport(viewportIdFor(0));
                  const driver =
                    nativeRef.current && document.querySelector("[data-native-viewport]")
                      ? await nativeDriver(cellKey(0))
                      : engine && vp
                        ? engineDriver(engine.core, vp as unknown as Parameters<typeof engineDriver>[1])
                        : null;
                  bench.current.marks.steps = driver ? await runStepsPass(driver) : { error: "no viewport to drive" };
                  void report();
                })();
              } else if (bench.current.firstPaint != null && benchView === "hooks") {
                // Test hook self-test (testHook.ts): rotation / flips drawn,
                // thumbnails rendered and counted, bindings set → reset → preset.
                void (async () => {
                  const hook = (window as unknown as { __flowradTest?: import("./testHook").FlowradTestHook }).__flowradTest;
                  bench.current.marks.hooks = hook ? await hook.selfTest().catch((e: unknown) => ({ ok: false, error: String(e) })) : { ok: false, error: "test hook not installed" };
                  void report();
                })();
              } else if (bench.current.firstPaint != null && benchView === "close") {
                // Close lifecycle (bench.mjs `close`): report with the study
                // open, hold it open while the bench samples it settled, then
                // close it like the Home button and say so; the bench samples
                // again after 30 s against the empty-app baseline.
                void (async () => {
                  await report();
                  const after = await invoke<number>("bench_close_after_ms").catch(() => 20_000);
                  window.setTimeout(() => {
                    goHomeRef.current();
                    void benchReport({ closed: true, closedAtMs: Math.round(performance.now() - t0) });
                  }, after);
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
        const built = await buildStudiesSliced(headers, { isCancelled: () => seq !== openSeq.current });
        if (!built || seq !== openSeq.current) return;
        rawOpen.current = { files };
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
      prewarmJsEngine();
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
      // A secondary window (another monitor) shows what its opener hands it:
      // no launch paths, no start-screen warm-up, no cold-start report.
      if (isSecondaryWindow) return;
      const initial = await takeLaunchPaths();
      // A study on the command line opens at once. The engine starts the
      // moment the instant preview is on screen (onPreview), not here:
      // measured, starting it with the scan put the preview at 440 ms (was 200).
      if (initial.length) {
        void openPaths(initial);
      } else {
        // Start screen: compile the engine in idle time so the first open does
        // not pay for it (code only: no WebGL context, no decode workers).
        const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
        // Soon after the start screen paints, not 1.5 s later: a reader who
        // opens a study within two seconds still found the engine cold.
        window.setTimeout(async () => {
          // Native renderer (Phase 2): the JS engine is not this window's
          // renderer, so the start screen stays at the WebView2 UI floor.
          if (isTauri && (await invoke<{ enabled: boolean }>("native_status").catch(() => null))?.enabled) return;
          preloadEngineChunks();
          if (idle) idle(() => prewarmEngine(), { timeout: 1000 });
          else prewarmEngine();
        }, 300);
      }
      if (!initial.length && (await benchEnabled())) {
        // Cold-start probe: report once the start screen has painted.
        requestAnimationFrame(() =>
          requestAnimationFrame(async () => {
            const ms = await invoke<number>("startup_elapsed_ms").catch(() => 0);
            const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
            // performance.now() counts from the webview's navigation start, so
            // ms − now() ≈ when the webview began loading the page: everything
            // before it is window + WebView2/WebKit start-up, after it is ours.
            const now = performance.now();
            const marks = await invoke<Record<string, number | string | null>>("startup_marks").catch(() => ({}));
            // First paint = the browser's own first-contentful-paint (Paint
            // Timing, relative to navigation start), placed on the process
            // clock. The time this callback runs is later by two frames and
            // three IPC round trips; it is kept as paintReportedMs.
            const fcp = performance.getEntriesByName?.("first-contentful-paint")[0]?.startTime;
            const navAt = Math.max(0, ms - now);
            // Where the page's own share goes (ms from navigation start): the
            // document, the stylesheet and entry script arriving, parsing
            // done, the entry script run (DOMContentLoaded), load.
            const r1 = (x: number | undefined) => (x == null || !(x > 0) ? null : Math.round(x));
            const nav = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
            const loaded = (re: RegExp) =>
              r1((performance.getEntriesByType?.("resource") as PerformanceResourceTiming[] | undefined)?.find((e) => re.test(e.name))?.responseEnd);
            const pageTiming = nav
              ? {
                  html: r1(nav.responseEnd),
                  css: loaded(/\/assets\/index-[^/]*\.css/),
                  js: loaded(/\/assets\/index-[^/]*\.js/),
                  interactive: r1(nav.domInteractive),
                  dcl: r1(nav.domContentLoadedEventEnd),
                  load: r1(nav.loadEventStart),
                  fcp: r1(fcp),
                }
              : null;
            await benchReport({
              pageTiming,
              coldStart: true,
              ...marks,
              firstPaintMs: fcp != null ? navAt + fcp : ms,
              firstPaintSource: fcp != null ? "first-contentful-paint" : "double-rAF",
              paintReportedMs: ms,
              webviewNavStartMs: navAt,
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
          if (p.type === "enter") prewarmJsEngine();
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
  // The cursor follows the left-button tool, however it was chosen (toolbar,
  // shortcut, voice). Volume views set their own.
  useEffect(() => {
    if (view === "grid") setToolCursor(leftTool);
  }, [leftTool, view]);

  useEffect(() => {
    if (!studies.length) return;
    let cancelled = false;
    withEngine((engine) => {
      if (cancelled) return;
      setGroupLeftTool(engine, STACK_GROUP, leftTool);
    });
    return () => {
      cancelled = true;
    };
    // handlesVersion: a JS-path viewport that started the engine (native mode) gets the tool too.
  }, [leftTool, studies.length, handlesVersion, withEngine]);

  // Slice geometry for sync and the 3D cursor, straight from the header scan.
  useEffect(() => {
    for (const study of studies) for (const series of study.series) registerGeometry(series.imageIds, series.headers);
  }, [studies]);

  /** Sync on = link the visible stacks at what each shows now (PACS-style registration). */
  const toggleSync = useCallback(() => {
    setSyncScroll((on) => {
      if (!on) {
        withEngine((engine) => {
          const ids = engineViewportIds(cells.flatMap((uid, i) => (uid ? [{ key: cellKey(i), id: viewportIdFor(i) }] : [])));
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
    withEngine((engine) => {
      if (cancelled) return;
      // Cornerstone synchronizers and reference lines only over the stacks the
      // engine draws: a native viewport id is unknown to it.
      const ids = engineViewportIds(visibleCells.filter((c) => c.uid).map((c) => ({ key: cellKey(c.i), id: viewportIdFor(c.i) })));
      setSynchronized(engine, "slice", ids, syncScroll);
      setSynchronized(engine, "voi", ids, syncVoi);
      setSynchronized(engine, "zoompan", ids, syncZoom);
      const activeId = engineViewportIds([{ key: cellKey(activeCell), id: viewportIdFor(activeCell) }])[0] ?? null;
      setReferenceSource(engine, activeId, referenceLines && ids.length > 1);
      setScaleOverlay(engine, settings.scaleBar);
    });
    return () => {
      cancelled = true;
    };
  }, [syncScroll, syncVoi, syncZoom, referenceLines, visibleCells, activeCell, handlesVersion, studies.length, settings.scaleBar]);

  /** Register the visible stacks at what each shows now (a prior, or a series with another FOV / frame). */
  const linkAtCurrent = useCallback(() => {
    withEngine((engine) => {
      const ids = engineViewportIds(cells.flatMap((uid, i) => (uid ? [{ key: cellKey(i), id: viewportIdFor(i) }] : [])));
      if (ids.length < 2) return toast({ title: "Linking needs two viewports", variant: "info", duration: 2500 });
      linkStacksAtCurrent(engine, ids, viewportIdFor(activeCell));
      setSyncScroll(true);
      toast({ title: "Linked at the current position", description: "Scrolling now keeps this anatomy together.", variant: "success", duration: 2500 });
    });
  }, [cells, activeCell, toast]);

  useEffect(() => {
    if (!studies.length) return;
    // F12 hides native annotations too (their own layer reads this).
    nativeAnnotations.setAnnotationsHidden(!annotationsVisible);
    withEngine((engine) => {
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

  const reformatAt = (i: number) => {
    const r = reformats[i];
    return r && r.uid === cells[i] ? r : null;
  };
  const activeReformat = reformatAt(activeCell);
  const setReformat = useCallback(
    (plane: "axial" | "coronal" | "sagittal" | null, cell = activeCell) => {
      const uid = cells[cell];
      if (plane && !uid) return;
      if (plane && !isTauri) {
        toast({ title: "Reformat needs the desktop app", description: "Use MPR for coronal and sagittal planes here.", variant: "info" });
        return;
      }
      slabCycle.current = "off";
      setReformats((prev) => {
        const next = { ...prev };
        if (plane && uid) next[cell] = { uid, plane };
        else delete next[cell];
        return next;
      });
    },
    [activeCell, cells, toast]
  );

  useEffect(() => {
    onSeriesDrop((uid, cell) => {
      showSeries(uid, cell);
      setActiveCell(cell);
    });
    return () => onSeriesDrop(null);
  }, [showSeries]);

  const onAnnotationsDeleted = useCallback(
    (count: number, scope: "one" | "image" | "series") => {
      if (scope === "one") return;
      toast({
        title: `${count} annotation${count === 1 ? "" : "s"} deleted ${scope === "image" ? "from this image" : "from the series"}`,
        description: `${keysForAction({ type: "undoAnnotation" }) ?? "Undo"} brings ${count === 1 ? "it" : "them"} back.`,
        variant: "info",
      });
    },
    [toast]
  );
  const onCopied = useCallback((text: string) => toast({ title: "Copied", description: text, variant: "info", duration: 2500 }), [toast]);

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

  // ───────────── offline voice commands ─────────────
  // The mic toggle loads the recognizer and model only when switched on and
  // frees them entirely when off (components/viewer/voice/voiceSession.ts).
  const [voice, setVoice] = useState<{ state: VoiceState; heard?: string | null }>({ state: "off" });
  const voiceSession = useRef<VoiceSession | null>(null);
  const voiceAction = useRef<(a: VoiceAction) => void>(() => undefined);
  /** The Home action, for the close-lifecycle bench (opened before `goHome` is defined). */
  const goHomeRef = useRef<() => void>(() => undefined);
  /** The open flow, for the bench's open/close rounds (it re-opens from inside an open). */
  const openPathsRef = useRef<(paths: string[]) => Promise<void>>(async () => undefined);
  openPathsRef.current = (paths) => openPaths(paths);
  const heardTimer = useRef(0);
  const showHeard = useCallback((heard: string) => {
    setVoice((v) => ({ ...v, heard }));
    window.clearTimeout(heardTimer.current);
    heardTimer.current = window.setTimeout(() => setVoice((v) => ({ ...v, heard: null })), 1800);
  }, []);
  const stopVoice = useCallback(() => {
    voiceSession.current?.stop();
    voiceSession.current = null;
  }, []);
  const [voiceProgress, setVoiceProgress] = useState<VoiceProgress | null>(null);
  // Hover / focus on the mic: start loading the recognizer so a click is ready at once.
  const warmVoice = useCallback(() => {
    if (voiceSession.current) return;
    void import("@/components/viewer/voice/voiceSession").then((m) => m.prewarmVoice(m.VOICE_MODEL_URL, m.VOICE_WORKER_URL));
  }, []);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const toggleVoiceRef = useRef<() => Promise<void>>(async () => undefined);
  toggleVoiceRef.current = async () => {
    if (voiceSession.current || voice.state === "loading") {
      stopVoice();
      setVoice((v) => ({ ...v, state: "off" }));
      return;
    }
    setVoiceError(null);
    setVoiceProgress(null);
    setVoice((v) => ({ ...v, state: "loading" }));
    const voiceModule = await import("@/components/viewer/voice/voiceSession");
    await voiceModule.startVoice({
      onSession: (session) => {
        voiceSession.current = session;
      },
      modelUrl: voiceModule.VOICE_MODEL_URL,
      workerUrl: voiceModule.VOICE_WORKER_URL,
      onAction: (action, heard) => {
        showHeard(heard);
        voiceAction.current(action);
      },
      onUnrecognized: (heard) => showHeard(`${heard} ?`),
      onProgress: setVoiceProgress,
      onState: (state, detail) => {
        setVoice((v) => ({ ...v, state }));
        if (state === "error") setVoiceError(detail ?? null);
        if (state === "off" || state === "error") voiceSession.current = null;
      },
    });
  };
  useEffect(() => () => stopVoice(), [stopVoice]);

  // ───────────── several windows / monitors (multiWindow.ts) ─────────────
  // Main + secondary viewer windows act as one reading station: a series can
  // go to another monitor (monitor picker on a series card, right-click menu,
  // Mod+Shift+N), the windows link scroll / W/L / zoom / reference lines, and
  // the main window remembers which layout sat on which monitor.
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [myMonitor, setMyMonitor] = useState<string | undefined>();
  /** Every other window's monitor and layout (from their window-state messages). */
  const otherWindows = useRef<Record<string, { monitor?: string; rows: number; cols: number; cells: (string | null)[]; studyKey?: string }>>({});
  const refreshMonitors = useCallback(async () => {
    const [list, mine] = await Promise.all([listMonitors(), currentMonitorName()]);
    setMonitors(list);
    setMyMonitor(mine);
    return list;
  }, []);
  useEffect(() => {
    if (!monitorsAvailable()) return;
    void refreshMonitors();
    const onFocus = () => void refreshMonitors();
    window.addEventListener("focus", onFocus);
    let timer = 0;
    let off: (() => void) | undefined;
    if (isTauri) {
      // Dragged to another monitor, or its scaling changed: re-read (debounced).
      const later = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void refreshMonitors(), 300);
      };
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        const w = getCurrentWindow();
        void Promise.all([w.onMoved(later), w.onScaleChanged(later)]).then((uns) => (off = () => uns.forEach((u) => u())));
      });
    }
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearTimeout(timer);
      off?.();
    };
  }, [refreshMonitors]);
  const myMonitorIndex = monitors.findIndex((m) => m.name === myMonitor);

  /** Main window: remember the other windows' monitors and layouts for next launch. */
  const persistArrangements = useCallback(() => {
    if (isSecondaryWindow || !isTauri) return;
    const list: WindowArrangement[] = Object.values(otherWindows.current).flatMap((w) => {
      const m = monitors.find((x) => x.name === w.monitor);
      return m ? [{ monitor: m, rows: w.rows, cols: w.cols, cells: w.cells, studyKey: w.studyKey }] : [];
    });
    updateSettings({ windowArrangements: list });
  }, [monitors, updateSettings]);

  /** What another window needs to show `sendCells` of this study. */
  const handoffFor = useCallback(
    (rows: number, cols: number, sendCells: (string | null)[]): WindowHandoff => {
      const offsets: Record<string, number> = {};
      for (const uid of sendCells) {
        const first = uid ? seriesByUid.get(uid)?.series.imageIds[0] : undefined;
        const off = first ? getStackOffset(first) : undefined;
        if (first && off != null) offsets[first] = off;
      }
      return {
        sourceLabel: source?.label ?? "Study",
        studyKey: source?.key,
        rows,
        cols,
        cells: sendCells,
        activeCell: 0,
        links: { scroll: syncScroll, voi: syncVoi, zoom: syncZoom, referenceLines },
        offsets,
        ...rawOpen.current,
      };
    },
    [seriesByUid, source, syncScroll, syncVoi, syncZoom, referenceLines]
  );

  benchHandoffRef.current = (uid: string) => ({ ...handoffFor(1, 1, [uid]), links: { scroll: true, voi: false, zoom: false, referenceLines: false } });

  const openedToast = useCallback(
    (monitorName: string | null) => {
      const n = monitors.findIndex((m) => m.name === monitorName) + 1;
      toast({
        title: n > 0 ? `Opened on monitor ${n}` : "Opened in a new window",
        description: syncScroll ? "Scrolling is linked across windows." : "Linked scroll across windows: F5.",
        variant: "success",
        duration: 2500,
      });
    },
    [monitors, syncScroll, toast]
  );

  /** Show `uid` on monitor `monitorName` (null: a new window here / a browser pop-out). */
  const sendSeriesToMonitor = useCallback(
    async (uid: string, monitorName: string | null) => {
      if (monitorName && monitorName === myMonitor) {
        showSeries(uid, activeCell);
        return;
      }
      const existing = monitorName ? Object.entries(otherWindows.current).find(([, w]) => w.monitor === monitorName) : undefined;
      if (existing && existing[1].studyKey === source?.key) {
        // Reuse that monitor's window: the series goes to its active pane.
        postToWindows({ kind: "show-series", from: windowId, to: existing[0], seriesUid: uid });
        openedToast(monitorName);
        return;
      }
      const monitor = monitors.find((m) => m.name === monitorName) ?? null;
      const id = await openViewerWindow(handoffFor(1, 1, [uid]), monitor, existing?.[0]);
      if (!id) {
        toast({ title: "Pop-up blocked", description: "Allow pop-ups for this page to open a series in a new window.", variant: "warning" });
        return;
      }
      otherWindows.current[id] = { monitor: monitor?.name, rows: 1, cols: 1, cells: [uid], studyKey: source?.key };
      persistArrangements();
      openedToast(monitor?.name ?? null);
    },
    [myMonitor, showSeries, activeCell, source, monitors, handoffFor, persistArrangements, openedToast, toast]
  );

  /** The whole layout to monitor `monitorName` (null: a new window). */
  const sendLayoutToMonitor = useCallback(
    async (monitorName: string | null) => {
      const existing = monitorName ? Object.entries(otherWindows.current).find(([, w]) => w.monitor === monitorName) : undefined;
      const monitor = monitors.find((m) => m.name === monitorName) ?? null;
      const id = await openViewerWindow(handoffFor(layout.rows, layout.cols, cells), monitor, existing?.[0]);
      if (!id) return;
      otherWindows.current[id] = { monitor: monitor?.name, rows: layout.rows, cols: layout.cols, cells, studyKey: source?.key };
      persistArrangements();
      openedToast(monitor?.name ?? null);
    },
    [monitors, handoffFor, layout, cells, source, persistArrangements, openedToast]
  );

  /** Mod+Shift+N / Mod+Alt+N: to the next monitor (or a new window with one monitor). */
  const sendToMonitor = useCallback(
    async (scope: "viewport" | "layout") => {
      const list = await refreshMonitors();
      const target = nextMonitor(list, myMonitor)?.name ?? null;
      if (scope === "layout") return sendLayoutToMonitor(target);
      if (activeSeriesUid) return sendSeriesToMonitor(activeSeriesUid, target);
    },
    [refreshMonitors, myMonitor, sendLayoutToMonitor, sendSeriesToMonitor, activeSeriesUid]
  );

  // The monitor picker on series cards.
  useEffect(() => {
    setMonitorSource(monitorsAvailable() ? () => refreshMonitors() : null);
    onSeriesToMonitor((uid, name) => void sendSeriesToMonitor(uid, name));
    return () => {
      setMonitorSource(null);
      onSeriesToMonitor(null);
    };
  }, [refreshMonitors, sendSeriesToMonitor]);

  // Window states, closes and "show this series" from the other windows.
  const windowMsgRef = useRef({ persistArrangements, showSeries, seriesByUid, activeCell });
  windowMsgRef.current = { persistArrangements, showSeries, seriesByUid, activeCell };
  useEffect(
    () =>
      onWindowMessage((m) => {
        const live = windowMsgRef.current;
        if (m.kind === "window-state") {
          otherWindows.current[m.from] = { monitor: m.monitor, rows: m.rows, cols: m.cols, cells: m.cells, studyKey: m.studyKey };
          live.persistArrangements();
        } else if (m.kind === "closed") {
          delete otherWindows.current[m.from];
          live.persistArrangements();
        } else if (m.kind === "show-series" && m.to === windowId && live.seriesByUid.has(m.seriesUid)) {
          live.showSeries(m.seriesUid, live.activeCell);
        }
      }),
    []
  );

  // Secondary window: tell the others where it is and what it shows.
  useEffect(() => {
    if (!isSecondaryWindow || !studies.length) return;
    const t = window.setTimeout(
      () => postToWindows({ kind: "window-state", from: windowId, monitor: myMonitor, rows: layout.rows, cols: layout.cols, cells, studyKey: source?.key }),
      150
    );
    return () => window.clearTimeout(t);
  }, [studies.length, myMonitor, layout, cells, source?.key]);

  useEffect(() => {
    window.addEventListener("pagehide", announceClosing);
    return () => window.removeEventListener("pagehide", announceClosing);
  }, []);

  // Links (scroll / W/L / zoom / reference lines) are shared by every window.
  const linksFromRemote = useRef(false);
  const linksInitial = useRef(true);
  useEffect(() => {
    if (linksInitial.current) {
      linksInitial.current = false;
      return;
    }
    if (linksFromRemote.current) {
      linksFromRemote.current = false;
      return;
    }
    postToWindows({ kind: "links", from: windowId, scroll: syncScroll, voi: syncVoi, zoom: syncZoom, referenceLines });
  }, [syncScroll, syncVoi, syncZoom, referenceLines]);
  const activeViewportHandle = studies.length && handlesVersion >= 0 ? getHandle(cellKey(activeCell)) : undefined;
  const remotePlanes = useCrossWindow({
    // Linked windows ride on the JS engine's events. Native mode: only once a
    // JS-path viewport has started the engine (re-checked as handles change).
    enabled: studies.length > 0 && (nativeMode === false || (handlesVersion >= 0 && enginePeek() != null)),
    viewportIds: visibleCells.filter((c) => c.uid && getHandle(cellKey(c.i))).map((c) => viewportIdFor(c.i)),
    active: activeViewportHandle ? { viewportId: activeViewportHandle.viewportId, element: activeViewportHandle.element } : null,
    links: { scroll: syncScroll, voi: syncVoi, zoom: syncZoom, referenceLines },
    onLinks: (l) => {
      linksFromRemote.current = true;
      setSyncScroll(l.scroll);
      setSyncVoi(l.voi);
      setSyncZoom(l.zoom);
      setReferenceLines(l.referenceLines);
    },
    monitorIndex: myMonitorIndex >= 0 ? myMonitorIndex : undefined,
  });

  // Main window, first study of the session: reopen the remembered windows on their monitors.
  const arrangementsRestored = useRef(false);
  useEffect(() => {
    if (isSecondaryWindow || arrangementsRestored.current || !studies.length || !source || growing) return;
    arrangementsRestored.current = true;
    const saved = settings.windowArrangements ?? [];
    if (!saved.length || !isTauri) return;
    void (async () => {
      const list = await refreshMonitors();
      const mainName = await currentMonitorName();
      const shown = new Set(cells.filter(Boolean));
      const pool = studies.flatMap((st) => st.series).filter((s) => s.imageCount > 0 && !shown.has(s.uid)).map((s) => s.uid);
      for (const [i, arr] of saved.entries()) {
        const monitor = placeArrangement(arr, i, list, mainName);
        if (!monitor) continue;
        const n = arr.rows * arr.cols;
        const restoredCells =
          arr.studyKey === source.key
            ? arr.cells.map((uid) => (uid && seriesByUid.has(uid) ? uid : null))
            : Array.from({ length: n }, () => pool.shift() ?? null);
        if (!restoredCells.some(Boolean)) continue;
        const id = await openViewerWindow(handoffFor(arr.rows, arr.cols, restoredCells), monitor);
        if (id) otherWindows.current[id] = { monitor: monitor.name, rows: arr.rows, cols: arr.cols, cells: restoredCells, studyKey: source.key };
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the first study has settled
  }, [studies.length, source, growing]);

  // Secondary window: show what the opener handed over (and again when it is re-sent).
  useEffect(() => {
    if (!isSecondaryWindow) return;
    const apply = async () => {
      const h = await takeHandoff();
      if (!h) return;
      autoHung.current = false;
      if (h.headers) {
        const grouped = (await buildStudiesSliced(h.headers)) ?? [];
        rawOpen.current = { headers: h.headers, documents: h.documents };
        const docs = (h.documents ?? []) as DicomDocument[];
        setDocuments(docs);
        setStudies(withKeyImageSeries(grouped, docs));
        setSource({ key: h.studyKey ?? `window:${windowId}`, paths: [], kind: "files", label: h.sourceLabel });
      } else if (h.files) {
        await openBrowserFiles(h.files);
        autoHung.current = false;
      }
      for (const [first, mm] of Object.entries(h.offsets ?? {})) setStackOffset(first, mm);
      setLayout({ rows: h.rows, cols: h.cols });
      setCells(Array.from({ length: h.rows * h.cols }, (_, i) => h.cells[i] ?? null));
      setActiveCell(Math.min(h.activeCell, h.rows * h.cols - 1));
      linksFromRemote.current = true;
      setSyncScroll(h.links.scroll);
      setSyncVoi(h.links.voi);
      setSyncZoom(h.links.zoom);
      setReferenceLines(h.links.referenceLines);
    };
    void apply();
    return onHandoffChanged(() => void apply());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per window
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
        case "escape": {
          // 1) a measurement being drawn → cancel it; 2) a tool other than
          // browsing → back to browsing; 3) then leave modes / full screen.
          // Native viewports have no Cornerstone enabled element: the engine's
          // cancel would destructure `renderingEngineId` of undefined (HP 0.8.0,
          // every Esc). Their own layer cancels a drawing on Escape.
          const element = handle?.element;
          if (element && !isNativeHandle(handle) && enginePeek()) {
            try {
              const cancelled = enginePeek()!.tools.cancelActiveManipulations(element);
              if (cancelled) return;
            } catch {
              /* no manipulation to cancel */
            }
          }
          if (leftTool !== "StackScroll" && view === "grid") {
            setLeftTool("StackScroll");
            return;
          }
          if (view !== "grid") {
            setView("grid");
            return;
          }
          if (activeReformat) {
            setReformat(null);
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
        case "slicePage": {
          const count = (activeSeriesUid && seriesByUid.get(activeSeriesUid)?.series.imageCount) || 10;
          return handle?.step(action.dir * Math.max(1, Math.round(count / 10)));
        }
        case "reformat":
          if (view !== "grid") setView("grid");
          return setReformat(activeReformat?.plane === action.plane ? null : action.plane);
        case "slabCycle": {
          if (!activeReformat && view !== "mpr") {
            toast({ title: "Slab works on a reformat or MPR", description: "Press Alt+C, Alt+S or Alt+A for a reformat, then T or Ctrl+wheel.", variant: "info" });
            return;
          }
          const order = ["off", "mip", "minip", "avg"] as const;
          slabCycle.current = order[(order.indexOf(slabCycle.current) + 1) % order.length];
          return setSlabCommand((c) => ({ mode: slabCycle.current, seq: (c?.seq ?? 0) + 1, cell: activeCell }));
        }
        case "slabThickness":
          if (!activeReformat && view !== "mpr") return;
          return setSlabCommand((c) => ({ deltaMm: action.deltaMm, seq: (c?.seq ?? 0) + 1, cell: activeCell }));
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
        case "orientReset":
          return handle?.resetOrientation();
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
        case "toggleSyncVoi":
          return setSyncVoi((v) => !v);
        case "toggleSyncZoom":
          return setSyncZoom((v) => !v);
        case "linkAtCurrent":
          return linkAtCurrent();
        case "sendToMonitor":
          return void sendToMonitor(action.scope);
        case "toggleReferenceLines":
          return setReferenceLines((v) => !v);
        case "toggleBrowser":
          return seriesPanel.toggle();
        case "export":
          if (view !== "grid") return;
          setExportInitial(undefined);
          return setDialog("export");
        case "mpr":
          return toggleView("mpr");
        case "volume3d":
          return toggleView("3d");
        case "fusion":
          return toggleView("fusion");
        // Native viewports keep their annotations in native/annotations.ts (undo
        // stack included); keys, menu and voice all come here, one step each.
        case "redoAnnotation":
          if (isNativeHandle(handle)) return void nativeAnnotations.redo();
          return withEngine((e) => annotationHistory(e, "redo"));
        case "undoAnnotation":
          if (isNativeHandle(handle)) return void nativeAnnotations.undo();
          return withEngine((e) => annotationHistory(e, "undo"));
        case "clearAnnotations":
          if (isNativeHandle(handle)) {
            // Undoable (Ctrl+Z brings them back), unlike closing the study.
            nativeAnnotations.removeAnnotations(nativeAnnotations.allAnnotations().map((a) => a.id));
            return;
          }
          return withEngine((e) => clearAnnotations(e));
        case "voice":
          return void toggleVoiceRef.current();
        default:
          return;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [studies.length, leftTool, toggleSync, linkAtCurrent, sendToMonitor, activeCell, presets, seriesOrder, activeSeriesUid, cells.length, maximized, distractionFree, view, openDialog, applyLayout, applyPreset, showSeries, toggleFullscreen, toggleView, activeReformat, setReformat, seriesByUid, toast]
  );

  // ───────────── right-click menus (shared @flowrad/viewer-core contextMenu) ─────────────
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<string>>(() => new Set());
  const [exportInitial, setExportInitial] = useState<{ kind?: ExportKind; format?: "png" | "jpeg"; overlay?: "none" | "anonymous" | "full" } | undefined>();
  const [tagsView, setTagsView] = useState<{ imageId: string; title?: string; description?: string; summary?: { label: string; value: string }[] } | null>(null);
  const menuMonitors = useMemo(
    () => (monitors.length > 1 ? monitors.map((m, i) => ({ name: m.name, number: i + 1, color: monitorColor(i), current: m.name === myMonitor })) : []),
    [monitors, myMonitor]
  );
  const priorEntries = useMemo(
    () => (isTauri && source && studies.length === 1 ? priorsFor(history, { key: source.key, patientId: studies[0]?.patient.id, studyDate: studies[0]?.date }) : []),
    [source, studies, history]
  );
  const comparePrior = useCallback(() => {
    const prior = priorEntries[0];
    if (!prior || !source) return toast({ title: "No prior of this patient on this computer", variant: "info", duration: 2500 });
    void openPaths([...source.paths, ...prior.paths], "folder", `${source.label} + prior`);
  }, [priorEntries, source, openPaths, toast]);

  /** A menu command as a keyboard action (for its shortcut, and to run it). */
  const commandAction = useCallback((command: MenuCommand, cellPresets: readonly WindowPreset[]): ShortcutAction | null => {
    const at = command.indexOf(":");
    const head = at < 0 ? command : command.slice(0, at);
    const arg = at < 0 ? "" : command.slice(at + 1);
    switch (head) {
      case "tool":
        return { type: "tool", tool: arg };
      case "preset": {
        if (arg === "auto") return { type: "presetDefault" };
        const i = cellPresets.findIndex((p) => p.id === arg);
        return i >= 0 ? { type: "preset", ordinal: i + 1 } : null;
      }
      case "invert":
        return { type: "invert" };
      case "zoom":
        return { type: "zoomTo", scale: arg === "fit" ? "fit" : Number(arg) };
      case "rotate":
        return { type: "rotate", degrees: Number(arg) };
      case "flip":
        return { type: "flip", axis: arg === "v" ? "v" : "h" };
      case "orient":
        return { type: "orientReset" };
      case "seriesPanel":
        return { type: "toggleBrowser" };
      case "reset":
        return { type: "reset" };
      case "reformat":
        return arg === "axial" || arg === "coronal" || arg === "sagittal" ? { type: "reformat", plane: arg } : null;
      case "mpr":
        return { type: "mpr" };
      case "3d":
        return { type: "volume3d" };
      case "layout": {
        const [rows, cols] = arg.split("x").map(Number);
        return rows && cols ? { type: "layout", rows, cols } : null;
      }
      case "link":
        return arg === "scroll" ? { type: "toggleSync" } : arg === "voi" ? { type: "toggleSyncVoi" } : { type: "toggleSyncZoom" };
      case "refLines":
        return { type: "toggleReferenceLines" };
      case "cine":
        return { type: "cine" };
      case "overlay":
        return { type: "toggleOverlay" };
      case "annotations":
        return { type: "toggleAnnotations" };
      default:
        return null;
    }
  }, []);

  /** Copy the image of a pane: its pixels only (the overlay text is not on the canvas). */
  const copyCellImage = useCallback(
    async (cell: number) => {
      const canvas = getHandle(cellKey(cell))?.element.querySelector("canvas");
      if (!canvas) return;
      try {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob || typeof ClipboardItem !== "function") throw new Error("no clipboard image support");
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        toast({ title: "Image copied", description: "Pixels only: no patient text on it.", variant: "success", duration: 2000 });
      } catch {
        toast({ title: "Could not copy the image", description: "Use Export → Save as PNG instead.", variant: "warning" });
      }
    },
    [toast]
  );

  /** Toolbar rotate / flip dropdown: the same actions as the keys and the menu. */
  const runOrientation = useCallback(
    (command: OrientationCommand) => {
      const action = commandAction(command, []);
      if (action) runAction(action);
    },
    [commandAction, runAction]
  );

  const runMenuCommand = useCallback(
    (command: MenuCommand, cell: number) => {
      autoHung.current = false;
      const handle = getHandle(cellKey(cell));
      const uid = cells[cell];
      const entry = uid ? seriesByUid.get(uid) : undefined;
      const at = command.indexOf(":");
      const head = at < 0 ? command : command.slice(0, at);
      const arg = at < 0 ? "" : command.slice(at + 1);
      switch (head) {
        case "slab": {
          const mode = arg as "off" | "mip" | "minip" | "avg";
          if (!reformatAt(cell)) {
            if (mode === "off") return;
            // A slab needs a reformat: the axial one, in that mode.
            setVoiceSlab({ mode, mm: 10 });
            return setReformat("axial", cell);
          }
          slabCycle.current = mode;
          return setSlabCommand((c) => ({ mode, seq: (c?.seq ?? 0) + 1, cell }));
        }
        case "slab-mm": {
          const mm = Number(arg);
          if (!reformatAt(cell)) {
            setVoiceSlab({ mode: "mip", mm });
            return setReformat("axial", cell);
          }
          return setSlabCommand((c) => ({ mm, seq: (c?.seq ?? 0) + 1, cell }));
        }
        case "monitor":
          return uid ? void sendSeriesToMonitor(uid, arg) : undefined;
        case "fps":
          return handle?.setCineFps(Number(arg));
        case "copyImage":
          return void copyCellImage(cell);
        case "save":
          setExportInitial({ kind: "image", format: arg === "jpeg" ? "jpeg" : "png", overlay: "none" });
          return setDialog("export");
        case "video":
          setExportInitial({ kind: "video" });
          return setDialog("export");
        case "tags": {
          const r = handle?.readout() as { index?: number; count?: number; header?: DesktopHeader } | null | undefined;
          const imageId = r?.header?.baseImageId ?? entry?.series.imageIds[r?.index ?? 0];
          if (!imageId || !entry) return;
          return setTagsView({
            imageId,
            description: `${entry.series.modality}${entry.series.number != null ? ` · Se ${entry.series.number}` : ""} · ${describeSeries(entry.series)}${r?.count ? ` · image ${(r.index ?? 0) + 1} of ${r.count}` : ""}`,
          });
        }
        case "comparePrior":
          return comparePrior();
        default: {
          const action = commandAction(command, windowPresetsFor(entry?.series.modality ?? ""));
          if (action) runAction(action);
        }
      }
    },
    [cells, seriesByUid, sendSeriesToMonitor, copyCellImage, comparePrior, commandAction, runAction, setReformat]
  );

  /** The image menu of pane `cell` (built when it opens). */
  const imageMenuFor = useCallback(
    (cell: number) => () => {
      const uid = cells[cell];
      const series = uid ? seriesByUid.get(uid)?.series : undefined;
      const modality = series?.modality ?? "";
      const cellPresets = windowPresetsFor(modality);
      const cine = getHandle(cellKey(cell))?.cine();
      const multi = (series?.imageCount ?? 0) > 1;
      const volume = !!series?.volumetric;
      return imageMenu({
        modality,
        tools: MENU_TOOLS,
        activeTool: leftTool,
        presets: cellPresets.map((p) => ({ id: p.id, label: p.label, ww: p.ww, wc: p.wc })),
        monitors: menuMonitors,
        links: { scroll: syncScroll, voi: syncVoi, zoom: syncZoom },
        referenceLines,
        overlay,
        annotations: annotationsVisible,
        cine: multi ? { playing: !!cine?.playing, fps: cine?.fps ?? 15 } : null,
        slab: isTauri && volume ? (reformatAt(cell) ? (cellSlabs[cell] ?? { mode: slabCycle.current, mm: 10 }) : { mode: "off", mm: 10 }) : null,
        layout,
        seriesPanel: distractionFree ? null : { shown: !seriesPanel.collapsed },
        can: {
          reformat: isTauri && volume,
          mpr: volume,
          threeD: volume,
          video: multi,
          tags: true,
          comparePrior: priorEntries.length > 0,
          copyImage: true,
          saveImage: true,
          customLayout: true,
        },
        shortcut: (id) => {
          const a = commandAction(id, cellPresets);
          return a ? keysForAction(a, settings.bindings) : undefined;
        },
      });
    },
    [cells, seriesByUid, leftTool, menuMonitors, syncScroll, syncVoi, syncZoom, referenceLines, overlay, annotationsVisible, layout, priorEntries, commandAction, settings.bindings, distractionFree, seriesPanel.collapsed]
  );
  const annotationShortcut = useCallback(
    (id: MenuCommand) => (id === "ann:delete" ? "Del" : undefined),
    []
  );

  /** Open `uid` in a new pane: the first empty one, or a grown layout. */
  const addPane = useCallback(
    (uid: string) => {
      const empty = cells.findIndex((c) => !c);
      if (empty >= 0) {
        showSeries(uid, empty);
        return setActiveCell(empty);
      }
      const next = layout.cols <= layout.rows ? { rows: layout.rows, cols: layout.cols + 1 } : { rows: layout.rows + 1, cols: layout.cols };
      autoHung.current = false;
      setMaximized(null);
      setLayout(next);
      setCells((prev) => [...prev, ...Array.from({ length: next.rows * next.cols - prev.length }, () => null)].map((v, i) => (i === prev.length ? uid : v)));
      setActiveCell(cells.length);
    },
    [cells, layout, showSeries]
  );

  const thumbMenuFor = useCallback(
    (uid: string) =>
      thumbnailMenu({
        monitors: menuMonitors,
        can: { newLayout: true, reformat: isTauri && !!seriesByUid.get(uid)?.series.volumetric, info: true, hide: true },
        shortcut: () => undefined,
      }),
    [menuMonitors, seriesByUid]
  );
  const onSeriesCommand = useCallback(
    (uid: string, command: MenuCommand) => {
      const series = seriesByUid.get(uid)?.series;
      if (command === "thumb:open") return showSeries(uid);
      if (command.startsWith("thumb:monitor:")) return void sendSeriesToMonitor(uid, command.slice("thumb:monitor:".length));
      if (command === "thumb:newLayout") return addPane(uid);
      if (command.startsWith("thumb:reformat:")) {
        const plane = command.slice("thumb:reformat:".length) as "coronal" | "sagittal";
        showSeries(uid);
        slabCycle.current = "off";
        return setReformats((prev) => ({ ...prev, [activeCell]: { uid, plane } }));
      }
      if (command === "thumb:info" && series?.imageIds[0]) {
        const h = series.headers[0];
        return setTagsView({
          imageId: h?.baseImageId ?? series.imageIds[0],
          title: "Series info",
          description: `${series.modality}${series.number != null ? ` · Se ${series.number}` : ""} · ${describeSeries(series)}`,
          summary: [
            { label: "Images", value: series.imageCount.toLocaleString() },
            ...(h?.sliceThickness != null ? [{ label: "Slice thickness", value: `${h.sliceThickness} mm` }] : []),
            ...(h?.pixelSpacing ? [{ label: "Pixel spacing", value: `${h.pixelSpacing.map((v) => Number(v).toFixed(3)).join(" × ")} mm` }] : []),
            ...(h?.rows && h?.columns ? [{ label: "Matrix", value: `${h.columns} × ${h.rows}` }] : []),
            { label: "Volume (MPR / 3D)", value: series.volumetric ? "Yes" : "No" },
          ],
        });
      }
      if (command === "thumb:hide") {
        setHiddenSeries((prev) => new Set([...prev, uid]));
        toast({ title: "Series hidden", description: "“Show all” at the top of the series list brings it back.", variant: "info", duration: 2500 });
      }
    },
    [seriesByUid, showSeries, sendSeriesToMonitor, addPane, activeCell, toast]
  );

  voiceAction.current = (a: VoiceAction) => {
    switch (a.type) {
      case "series":
        return runAction({ type: "series", delta: a.delta });
      case "slice":
        return runAction({ type: "slice", delta: a.delta });
      case "page":
        return runAction({ type: "slicePage", dir: a.dir });
      case "zoom":
        return runAction({ type: "zoomBy", factor: a.factor });
      case "tool":
        return runAction({ type: "tool", tool: a.tool });
      case "reset":
        return runAction({ type: "reset" });
      case "invert":
        return runAction({ type: "invert" });
      case "mpr":
        return runAction({ type: "mpr" });
      case "volume3d":
        return runAction({ type: "volume3d" });
      case "slab":
        // A slab needs a reformat: open the axial one with that mode.
        if (!activeReformat && a.mode !== "off") {
          setVoiceSlab({ mode: a.mode, mm: 10 });
          return runAction({ type: "reformat", plane: "axial" });
        }
        slabCycle.current = a.mode;
        return setSlabCommand((c) => ({ mode: a.mode, seq: (c?.seq ?? 0) + 1, cell: activeCell }));
      case "slabThickness":
        return runAction({ type: "slabThickness", deltaMm: a.deltaMm });
      case "layout":
        return runAction({ type: "layout", rows: a.rows, cols: a.cols });
      case "preset": {
        const want = a.name === "abdomen" ? /abdom|soft/i : new RegExp(a.name, "i");
        const preset = presets.find((p) => want.test(p.label) || want.test(p.id));
        if (preset) return applyPreset(preset);
        return toast({ title: `No ${a.name} window for this series`, variant: "info", duration: 2500 });
      }
      case "stop":
        return stopVoice();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (dialog) return;
      // Tab switches series only from the image; on a control it still moves focus.
      if (e.key === "Tab" && target && target !== document.body && target.closest("button, a, [role=menuitem], [tabindex]")) return;
      const action = resolveShortcut(e, undefined, settings.bindings);
      if (!action) return;
      e.preventDefault();
      runAction(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runAction, dialog, settings.bindings]);

  // macOS: WKWebView can't tell side buttons from the middle one, nor a tilt
  // wheel from a trackpad, so the shell forwards them (src/macMouse.ts). Only
  // what the bindings use (or the open Mouse & Keyboard panel) is forwarded.
  const macBindingSpecs = useMemo(() => [...inputIndex(DESKTOP_COMMANDS, settings.bindings ?? {}).keys()], [settings.bindings]);
  useEffect(() => {
    if (!isMac()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void import("./macMouse").then((m) => {
      if (gone) return;
      stop = m.startNativeMouse();
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
  useEffect(() => {
    if (!isMac()) return;
    void import("./macMouse").then((m) => m.setNativeMouseBindings(macBindingSpecs));
  }, [macBindingSpecs]);

  // Mouse buttons (middle, back / forward, any extra button of a gaming or
  // programmable mouse) and wheel tilt bound to commands in Settings. Only
  // inside the viewports; browser defaults are suppressed only when bound.
  // Loaded with the first study (not at startup).
  // Attached once per open study: the handler reads the current action and
  // bindings through refs, so streaming scan batches (which change runAction)
  // don't re-attach it on every render.
  const studyOpen = studies.length > 0;
  const runActionRef = useRef(runAction);
  runActionRef.current = runAction;
  const bindingsRef = useRef(settings.bindings);
  bindingsRef.current = settings.bindings;
  useEffect(() => {
    if (dialog || !studyOpen) return;
    let detach: (() => void) | null = null;
    let gone = false;
    void import("@flowrad/viewer-core/bindings/dom").then(({ attachMouseCommands }) => {
      if (gone) return;
      detach = attachMouseCommands(window, {
        within: (t) => {
          const el = t instanceof Element ? t : null;
          return !!el?.closest("main") && !el.closest("aside, [role=menu], [role=dialog], button, input, textarea, select, [data-series-panel]");
        },
        isBound: (spec) => inputIndex(DESKTOP_COMMANDS, bindingsRef.current ?? {}).has(normalizeSpec(spec)),
        run: (spec) => {
          const action = resolveInput(spec, bindingsRef.current ?? {});
          if (!action) return false;
          runActionRef.current(action);
          return true;
        },
      });
    });
    return () => {
      gone = true;
      detach?.();
    };
  }, [dialog, studyOpen]);

  const goHome = useCallback(() => {
    openSeq.current += 1;
    void cancelScan();
    // Native renderer: every viewport and decoded slice freed (back to baseline).
    if (native) {
      void invoke("native_close").catch(() => undefined);
      void import("./native/annotations").then((m) => m.clearAnnotations());
    }
    setScan(null);
    setGrowing(false);
    setSource(null);
    resetWorkspace();
    historyList<HistoryEntry>().then(setHistory, () => undefined);
  }, [resetWorkspace, native]);
  goHomeRef.current = goHome;

  // Bench / e2e test hook (window.__flowradTest): bench or test mode only,
  // gated like benchReport (FLOWRAD_BENCH=1, or ?bench in the browser build).
  const testHookState = useRef({ studies, hiddenSeries, settings, seriesPanel, activeCell });
  testHookState.current = { studies, hiddenSeries, settings, seriesPanel, activeCell };
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void benchEnabled().then(async (on) => {
      if (!on || cancelled) return;
      const { installTestHook } = await import("./testHook");
      if (cancelled) return;
      const st = () => testHookState.current;
      off = installTestHook({
        activeHandle: () => getHandle(cellKey(st().activeCell)),
        activeCellKey: () => cellKey(st().activeCell),
        studies: () => st().studies,
        hiddenSeries: () => st().hiddenSeries,
        seriesPanel: () => ({ collapsed: st().seriesPanel.collapsed, compact: !!st().settings.compactSeries }),
        openSeriesPanel: () => st().seriesPanel.collapsed && st().seriesPanel.toggle(),
        bindings: () => st().settings.bindings ?? {},
        updateBindings: (next) => updateSettings({ bindings: Object.fromEntries(Object.entries(next).map(([k, v]) => [k, [...v]])) }),
      });
    }, () => undefined);
    return () => {
      cancelled = true;
      off?.();
    };
  }, [updateSettings]);

  const onPreview = useCallback((fullRes: boolean) => {
    const at = performance.now() - bench.current.t0;
    if (bench.current.marks.firstPreviewMs == null) bench.current.marks.firstPreviewMs = at;
    // A full-resolution preview at the file's window IS the first image the
    // reader sees (the engine's paint replaces it with the same pixels).
    if (fullRes && bench.current.marks.firstFullResMs == null) bench.current.marks.firstFullResMs = at;
    // The preview is what the reader sees first; start the engine right
    // behind it instead of waiting for the viewport's next frame + task.
    // (Native mode: the native viewport draws; no JS engine.)
    prewarmJsEngine();
  }, [prewarmJsEngine]);

  const onFirstPaint = useCallback((ms?: number, _health?: unknown, nativeShow?: FirstNativeShow) => {
    if (bench.current.firstPaint != null) return;
    const at = performance.now() - bench.current.t0;
    bench.current.firstPaint = at;
    // Native: where the last stretch went (viewport asked → Rust's own split).
    if (nativeShow && ms != null) {
      bench.current.marks.firstViewportSentMs = at - ms;
      bench.current.marks.nativeFirst = {
        roundTripMs: Math.round(ms * 10) / 10,
        cached: nativeShow.cached,
        decodeMs: Math.round(nativeShow.decodeMs * 10) / 10,
        frameMs: Math.round(nativeShow.frameMs * 10) / 10,
        acquireMs: nativeShow.acquireMs != null ? Math.round(nativeShow.acquireMs * 10) / 10 : null,
        rustMs: Math.round(nativeShow.totalMs * 10) / 10,
      };
    }
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

      <VoiceStatus
        className="fixed right-3 top-12 z-50"
        state={voice.state}
        progress={voiceProgress}
        error={voiceError}
        onRetry={() => {
          setVoice((v) => ({ ...v, state: "off" }));
          void toggleVoiceRef.current();
        }}
        onDismiss={() => {
          stopVoice();
          setVoice((v) => ({ ...v, state: "off" }));
        }}
      />
      {hasStudy && !distractionFree && (
        <Toolbar
          shortcuts={settings.bindings}
          leftTool={leftTool}
          onTool={setLeftTool}
          presets={presets}
          onPreset={applyPreset}
          onCustomWindow={() => setDialog("window")}
          onInvert={() => handle?.invert()}
          onReset={() => handle?.reset()}
          onOrientation={(command) => runOrientation(command)}
          layout={layout}
          onLayout={applyLayout}
          syncScroll={syncScroll}
          onToggleSync={toggleSync}
          syncVoi={syncVoi}
          syncZoom={syncZoom}
          onToggleSyncVoi={() => setSyncVoi((v) => !v)}
          onToggleSyncZoom={() => setSyncZoom((v) => !v)}
          onLinkAtCurrent={linkAtCurrent}
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
          voice={isTauri || typeof navigator.mediaDevices?.getUserMedia === "function" ? { state: voice.state, heard: voice.heard, onToggle: () => void toggleVoiceRef.current(), onWarm: warmVoice } : undefined}
          onUndo={() => runAction({ type: "undoAnnotation" })}
          onRedo={() => runAction({ type: "redoAnnotation" })}
          onClear={() => runAction({ type: "clearAnnotations" })}
          onFullscreen={() => void toggleFullscreen()}
          onHelp={() => setDialog("help")}
          onSettings={() => setDialog("settings")}
          volumeView={view !== "grid"}
          onExport={
            view === "grid"
              ? () => {
                  setExportInitial(undefined);
                  setDialog("export");
                }
              : undefined
          }
          onSend={sync.status.signedIn ? () => setDialog("send") : undefined}
          advanced={{
            mprAvailable: !!volumeSeries,
            fusionAvailable: !!fusionPair,
            view,
            onMpr: () => toggleView("mpr"),
            onVolume: () => toggleView("3d"),
            onFusion: () => toggleView("fusion"),
            reformat: view === "grid" ? activeReformat?.plane ?? null : null,
            onReformat: isTauri && settings.nativeMpr ? (plane) => {
              if (view !== "grid") setView("grid");
              setReformat(plane);
            } : undefined,
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
            {!distractionFree && (
              <CollapsiblePanel
                label="Series"
                tone="surface"
                collapsed={seriesPanel.collapsed}
                onToggle={seriesPanel.toggle}
                shortcut={[keysForAction({ type: "toggleBrowser" }) ?? ""]}
                widthClassName="w-[244px]"
              >
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
                  hidden={hiddenSeries}
                  onShowHidden={() => setHiddenSeries(new Set())}
                  menuFor={thumbMenuFor}
                  onSeriesCommand={onSeriesCommand}
                />
              </CollapsiblePanel>
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
            ) : view === "mpr" && isTauri && settings.nativeMpr && volumeSeries && nativeMprUnsupported !== volumeSeries.uid ? (
              <NativeMprView
                series={volumeSeries}
                initialSlab={benchSlab}
                slabCommand={slabCommand}
                onExit={() => setView("grid")}
                onUnsupported={() => setNativeMprUnsupported(volumeSeries.uid)}
                onVolumeReady={(t) => {
                  bench.current.marks.volumeLoadedMs = t.loadedMs;
                  bench.current.marks.volumeBuildMs = t.shellMs;
                }}
                onPainted={(t) => {
                  // Done = pixels on screen in every pane, not "volume built"
                  // (0.6.0 built in 0.36 s and never painted on the HP).
                  bench.current.marks.mprPaintedMs = t.ms;
                  bench.current.marks.mprPanes = t.maxLum;
                  if (benchSlab) bench.current.marks.mprSlab = `${benchSlab.mode}:${benchSlab.mm}`;
                  const pending = bench.current.pendingVolume;
                  bench.current.pendingVolume = undefined;
                  void pending?.();
                }}
              />
            ) : view === "3d" && isTauri && settings.nativeMpr && volumeSeries && nativeMprUnsupported !== volumeSeries.uid ? (
              <Native3DView
                series={volumeSeries}
                onExit={() => setView("grid")}
                onUnsupported={() => setNativeMprUnsupported(volumeSeries.uid)}
                onVolumeReady={(t) => {
                  bench.current.marks.volumeLoadedMs = t.loadedMs;
                  bench.current.marks.volumeBuildMs = t.shellMs;
                }}
                onPainted={(t) => {
                  bench.current.marks.vrPaintedMs = t.ms;
                  bench.current.marks.vrPanes = t.maxLum;
                  const pending = bench.current.pendingVolume;
                  bench.current.pendingVolume = undefined;
                  void pending?.();
                }}
              />
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
              data-native-grid={native || undefined}
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
                const reformat = reformatAt(i);
                if (reformat && entry)
                  return (
                    <NativePlaneView
                      key={`r${i}`}
                      series={entry.series}
                      plane={reformat.plane}
                      cellIndex={i}
                      active={i === activeCell}
                      dropHover={seriesDrag?.cell === i}
                      onActivate={() => {
                        autoHung.current = false;
                        setActiveCell(i);
                      }}
                      onClose={() => setReformat(null, i)}
                      slabCommand={slabCommand}
                      initialSlab={benchSlab ?? voiceSlab}
                      onSlabChange={(slab) => setCellSlabs((m) => (m[i]?.mode === slab.mode && m[i]?.mm === slab.mm ? m : { ...m, [i]: slab }))}
                      imageMenu={imageMenuFor(i)}
                      onMenuCommand={(command) => runMenuCommand(command, i)}
                      onPainted={(t) => {
                        bench.current.marks.reformat = { plane: reformat.plane, ms: Math.round(t.ms), maxLum: t.maxLum, slab: `${t.slab.mode}:${t.slab.mm}` };
                        const pending = bench.current.pendingVolume;
                        bench.current.pendingVolume = undefined;
                        void pending?.();
                      }}
                    />
                  );
                // Native mode not known yet (a few ms after start): hold the cell.
                if (nativeMode === null && entry?.series) return <div key={`w${i}`} className="min-h-0 min-w-0" aria-busy="true" />;
                if (native && entry?.series && nativeCapable(entry.series))
                  return (
                    <NativeStackViewport
                      key={`n${i}`}
                      cellKey={cellKey(i)}
                      viewportId={viewportIdFor(i)}
                      series={entry.series}
                      study={entry.study}
                      active={i === activeCell}
                      cellIndex={i}
                      dropHover={seriesDrag?.cell === i}
                      showOverlay={overlay}
                      hidePatient={settings.hidePatient}
                      growing={growing}
                      tool={leftTool}
                      onActivate={() => {
                        autoHung.current = false;
                        setActiveCell(i);
                      }}
                      onDropSeries={(dropped) => showSeries(dropped, i)}
                      onDoubleClick={() => cells.length > 1 && setMaximized((m) => (m == null ? i : null))}
                      onFirstPaint={onFirstPaint}
                      onAnnotationsDeleted={onAnnotationsDeleted}
                      imageMenu={imageMenuFor(i)}
                      onMenuCommand={(command) => runMenuCommand(command, i)}
                    />
                  );
                return (
                  <StackViewport
                    key={i}
                    cellKey={cellKey(i)}
                    viewportId={viewportIdFor(i)}
                    series={entry?.series ?? null}
                    study={entry?.study ?? null}
                    active={i === activeCell}
                    cellIndex={i}
                    dropHover={seriesDrag?.cell === i}
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
                    eraser={leftTool === "Eraser"}
                    onAnnotationsDeleted={onAnnotationsDeleted}
                    onCopied={onCopied}
                    imageMenu={uid ? imageMenuFor(i) : undefined}
                    onMenuCommand={(command) => runMenuCommand(command, i)}
                    menuShortcut={annotationShortcut}
                    remotePlanes={remotePlanes}
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
            onIntent={warmForOpen}
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
          {monitors.length > 1 && myMonitorIndex >= 0 && <MonitorBadge number={myMonitorIndex + 1} color={monitorColor(myMonitorIndex)} />}
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
            {syncVoi && "W/L sync · "}
            {syncZoom && "Zoom sync · "}
            {leftTool.replace(/([a-z])([A-Z])/g, "$1 $2")} · Not for diagnostic use
          </span>
        </footer>
      )}

      <Suspense fallback={null}>
      {hud && <MemoryHud onClose={() => setHud(false)} />}
      {seriesDrag?.picker && <MonitorPicker picker={seriesDrag.picker} />}
      {seriesDrag && !(seriesDrag.picker && insidePicker(seriesDrag.picker, seriesDrag.x, seriesDrag.y)) && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 max-w-[240px] -translate-y-full truncate rounded-md border border-accent bg-elevated/95 px-2 py-1 text-xs font-medium text-primary shadow-lg"
          // Dynamic position: follows the pointer.
          style={{ left: seriesDrag.x + 12, top: seriesDrag.y - 8 }}
        >
          {seriesDrag.label}
        </div>
      )}
      {dialog === "help" && (
      <ShortcutsDialog open={dialog === "help"} onClose={() => setDialog(null)} overrides={settings.bindings} />
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
        initial={exportInitial}
      />
      )}
      {tagsView && (
        <DicomTagsDialog
          open
          onClose={() => setTagsView(null)}
          imageId={tagsView.imageId}
          title={tagsView.title}
          description={tagsView.description}
          summary={tagsView.summary}
          hidePatient={settings.hidePatient}
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
                  <span className="block text-sm font-medium text-primary">Check for updates automatically</span>
                  <span className="block text-xs text-muted">
                    On launch and every few hours. Updates download in the background and install only when you restart. Only the update
                    check is sent: no study, patient or personal data.
                  </span>
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
                        ? `Version ${updater.status.update.version} is ready: restart to install.`
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
