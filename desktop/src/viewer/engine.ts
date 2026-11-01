// Cornerstone3D, initialised once for the whole window.
//
// One RenderingEngine drives every viewport (a second engine allocates a
// second WebGL context pool — see the note in components/CornerstoneViewer).
// Engine knobs come from `lib/viewerRuntime.ts`, the same functions the web
// viewer and the benchmark harness use.
//
// The engine is imported lazily: the start screen must paint before a single
// byte of Cornerstone is parsed (cold start budget < 0.5 s), and it is
// pre-warmed in idle time right after first paint.

import {
  coreInitConfig,
  detectDeviceProfile,
  imageCacheBytes,
  retrievalPoolSizes,
  webWorkerCount,
} from "@flowrad/viewer-core";
import { tuneStackScrollTool } from "@flowrad/viewer-core";
import { installDatasetTrim } from "./memory";

/** Decoded-image budget: holds a 1,500-slice 512² CT, or a 2,000-slice 256² MR, with room for an MPR. */
const DESKTOP_CACHE_BUDGET = 1024 * 1024 * 1024;

type Core = typeof import("@cornerstonejs/core");
type Tools = typeof import("@cornerstonejs/tools");

export interface Engine {
  core: Core;
  tools: Tools;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderingEngine: any;
}

export const ENGINE_ID = "radlearn-desktop";
export const STACK_GROUP = "stack";
export const MPR_GROUP = "mpr";
export const VR_GROUP = "vr";
/** PET MIP: no crosshairs (its slab spans the body, so a crosshair band would cover it). */
export const MIP_GROUP = "petmip";

/** Left-button tools the toolbar offers, by Cornerstone tool name. */
export const LEFT_TOOLS = [
  "StackScroll",
  "WindowLevel",
  "Zoom",
  "Pan",
  "Length",
  "Angle",
  "CobbAngle",
  "EllipticalROI",
  "RectangleROI",
  "CircleROI",
  "PlanarFreehandROI",
  "Probe",
  "ArrowAnnotate",
  "Bidirectional",
  "Magnify",
] as const;
export type LeftTool = (typeof LEFT_TOOLS)[number] | "Crosshairs" | "TrackballRotate";

export const MEASUREMENT_TOOLS = [
  "Length",
  "Angle",
  "CobbAngle",
  "EllipticalROI",
  "RectangleROI",
  "CircleROI",
  "PlanarFreehandROI",
  "Probe",
  "ArrowAnnotate",
  "Bidirectional",
];

let enginePromise: Promise<Engine> | null = null;

/** Start loading the engine chunks without initialising (idle pre-warm). */
export function prewarmEngine(): void {
  void import("@cornerstonejs/core");
  void import("@cornerstonejs/tools");
  void import("@cornerstonejs/dicom-image-loader");
}

/** Wall-clock cost of the last engine init, for the benchmark report. */
export const engineTimings: { initMs?: number } = {};

let engineReady: Engine | null = null;
/** The engine if it is already initialised, without starting it. */
export function enginePeek(): Engine | null {
  return engineReady;
}

export function getEngine(): Promise<Engine> {
  if (!enginePromise) {
    const t0 = performance.now();
    enginePromise = createEngine().then((e) => {
      engineTimings.initMs = performance.now() - t0;
      engineReady = e;
      return e;
    });
  }
  return enginePromise;
}

async function createEngine(): Promise<Engine> {
  const [core, tools, loader] = await Promise.all([
    import("@cornerstonejs/core"),
    import("@cornerstonejs/tools"),
    import("@cornerstonejs/dicom-image-loader"),
  ]);
  const profile = detectDeviceProfile();
  // Desktop: never the mobile profile, whatever the pointer says.
  profile.isMobile = false;
  await core.init(coreInitConfig(profile) as Parameters<typeof core.init>[0]);
  await tools.init();
  // Desktop: the reader is the only workload, so decode on every core (the web
  // viewer leaves a quarter free for the page; lib/viewerRuntime.ts).
  // Legacy dataset path: the metadata tags are read from a dicom-parser dataset
  // that memory.ts trims to its header after decode. The default (naturalized)
  // path pins every file's full bytes in a metadata store for the session.
  await loader.init({
    maxWebWorkers: Math.max(webWorkerCount(profile), Math.min(profile.cores, 12)),
    useLegacyMetadataProvider: true,
  } as Parameters<typeof loader.init>[0]);
  installDatasetTrim(core, loader);
  try {
    // Honest now that raw file bytes are released after decode (memory.ts):
    // this budget is close to what the decoded images really hold. LRU
    // eviction keeps a long session from growing past it.
    core.cache.setMaxCacheSize(Math.min(imageCacheBytes(profile), DESKTOP_CACHE_BUDGET));
  } catch {
    /* library default */
  }
  const pool = (core as unknown as { imageRetrievalPoolManager?: { maxNumRequests?: Record<string, number> } })
    .imageRetrievalPoolManager?.maxNumRequests;
  // Local disk: there is no server to be polite to. Keep interaction deep.
  if (pool) Object.assign(pool, { ...retrievalPoolSizes(profile), interaction: 32, prefetch: 32 });
  // Volume loads (MPR / 3D) run in the prefetch lane of BOTH pools: fetch and
  // decode. Local disk has no server to protect, so keep the decoders fed.
  const decodePool = (core as unknown as { imageLoadPoolManager?: { maxNumRequests?: Record<string, number> } })
    .imageLoadPoolManager?.maxNumRequests;
  if (decodePool) Object.assign(decodePool, { interaction: 32, prefetch: 32, thumbnail: 4 });

  const t = tools;
  for (const Tool of [
    t.StackScrollTool,
    t.WindowLevelTool,
    t.ZoomTool,
    t.PanTool,
    t.LengthTool,
    t.AngleTool,
    t.CobbAngleTool,
    t.EllipticalROITool,
    t.RectangleROITool,
    t.CircleROITool,
    t.PlanarFreehandROITool,
    t.ProbeTool,
    t.ArrowAnnotateTool,
    t.BidirectionalTool,
    t.MagnifyTool,
    t.ReferenceLinesTool,
    t.CrosshairsTool,
    t.TrackballRotateTool,
    t.OrientationMarkerTool,
    t.ScaleOverlayTool,
  ]) {
    try {
      t.addTool(Tool);
    } catch {
      /* already registered (HMR) */
    }
  }

  const renderingEngine = new core.RenderingEngine(ENGINE_ID);
  const engine: Engine = { core, tools, renderingEngine };
  buildStackGroup(engine);
  return engine;
}

function bindingsFor(engine: Engine) {
  const { MouseBindings, KeyboardBindings } = engine.tools.Enums;
  return { MouseBindings, KeyboardBindings };
}

/**
 * Mouse map (RadiAnt-compatible where it matters):
 *   left   = the toolbar tool (default: browse slices)
 *   wheel  = slice;  Ctrl+wheel = zoom
 *   right  = window / level
 *   middle = pan
 */
function buildStackGroup(engine: Engine) {
  const { tools } = engine;
  const { MouseBindings, KeyboardBindings } = bindingsFor(engine);
  const group = tools.ToolGroupManager.createToolGroup(STACK_GROUP)!;
  for (const name of [...LEFT_TOOLS, "ReferenceLines", "ScaleOverlay"]) group.addTool(name);
  group.addTool("ArrowAnnotate", {
    getTextCallback: (done: (text: string) => void) => done(window.prompt("Annotation text") ?? ""),
    changeTextCallback: (_d: unknown, _e: unknown, done: (text: string) => void) =>
      done(window.prompt("Annotation text") ?? ""),
  });
  group.setToolActive("StackScroll", { bindings: [{ mouseButton: MouseBindings.Wheel }] });
  group.setToolActive("Zoom", {
    bindings: [{ mouseButton: MouseBindings.Wheel, modifierKey: KeyboardBindings.Ctrl }],
  });
  group.setToolActive("WindowLevel", { bindings: [{ mouseButton: MouseBindings.Secondary }] });
  group.setToolActive("Pan", { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
  for (const name of MEASUREMENT_TOOLS) group.setToolPassive(name);
  tuneStackScrollTool(group.getToolInstance("StackScroll"));
  leftByGroup.set(STACK_GROUP, null);
  setGroupLeftTool(engine, STACK_GROUP, "StackScroll");
}

const leftByGroup = new Map<string, string | null>();

export function setGroupLeftTool(engine: Engine, groupId: string, name: string): void {
  const group = engine.tools.ToolGroupManager.getToolGroup(groupId);
  if (!group || !group.hasTool(name)) return;
  const { MouseBindings } = bindingsFor(engine);
  const primary = { mouseButton: MouseBindings.Primary };
  const previous = leftByGroup.get(groupId);
  if (previous && previous !== name) {
    // Strip ONLY the left button from the outgoing tool (see lib/toolBindings.ts):
    // setToolActive merges bindings and the first match wins.
    group.setToolPassive(previous, { removeAllBindings: [primary] });
    if (previous === "StackScroll") {
      group.setToolActive("StackScroll", { bindings: [{ mouseButton: MouseBindings.Wheel }] });
    }
    if (previous === "WindowLevel") {
      group.setToolActive("WindowLevel", { bindings: [{ mouseButton: MouseBindings.Secondary }] });
    }
    if (previous === "Pan") {
      group.setToolActive("Pan", { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
    }
    if (previous === "Zoom") {
      group.setToolActive("Zoom", {
        bindings: [{ mouseButton: MouseBindings.Wheel, modifierKey: bindingsFor(engine).KeyboardBindings.Ctrl }],
      });
    }
  }
  group.setToolActive(name, { bindings: [primary] });
  leftByGroup.set(groupId, name);
}

export function addViewportToGroup(engine: Engine, groupId: string, viewportId: string): void {
  const group = engine.tools.ToolGroupManager.getToolGroup(groupId);
  group?.addViewport(viewportId, ENGINE_ID);
}

export function removeViewportFromGroups(engine: Engine, viewportId: string): void {
  for (const id of [STACK_GROUP, MPR_GROUP, VR_GROUP, MIP_GROUP]) {
    try {
      engine.tools.ToolGroupManager.getToolGroup(id)?.removeViewports(ENGINE_ID, viewportId);
    } catch {
      /* not a member */
    }
  }
}

/** Reference lines: draw the active viewport's plane on every other one. */
export function setReferenceSource(engine: Engine, viewportId: string | null, enabled: boolean): void {
  const group = engine.tools.ToolGroupManager.getToolGroup(STACK_GROUP);
  if (!group) return;
  if (!enabled || !viewportId) {
    group.setToolDisabled("ReferenceLines");
    return;
  }
  group.setToolConfiguration("ReferenceLines", { sourceViewportId: viewportId });
  group.setToolEnabled("ReferenceLines");
}

export function setScaleOverlay(engine: Engine, enabled: boolean): void {
  const group = engine.tools.ToolGroupManager.getToolGroup(STACK_GROUP);
  if (!group) return;
  if (enabled) group.setToolEnabled("ScaleOverlay");
  else group.setToolDisabled("ScaleOverlay");
}

// ───────────────────────────── synchronizers ─────────────────────────────

export type SyncKind = "slice" | "voi" | "zoompan";
const SYNC_IDS: Record<SyncKind, string> = {
  slice: "sync-slice",
  voi: "sync-voi",
  zoompan: "sync-zoompan",
};

export function ensureSynchronizer(engine: Engine, kind: SyncKind) {
  const { synchronizers, SynchronizerManager } = engine.tools;
  const existing = SynchronizerManager.getSynchronizer(SYNC_IDS[kind]);
  if (existing) return existing;
  if (kind === "slice") return synchronizers.createImageSliceSynchronizer(SYNC_IDS[kind]);
  if (kind === "voi") return synchronizers.createVOISynchronizer(SYNC_IDS[kind], { syncInvertState: true, syncColormap: false });
  return synchronizers.createZoomPanSynchronizer(SYNC_IDS[kind]);
}

/** Put exactly `viewportIds` in the synchronizer (or none when disabled). */
export function setSynchronized(engine: Engine, kind: SyncKind, viewportIds: string[], enabled: boolean): void {
  const sync = ensureSynchronizer(engine, kind);
  for (const vp of [...sync.getSourceViewports()]) sync.remove(vp);
  if (!enabled || viewportIds.length < 2) return;
  for (const viewportId of viewportIds) sync.add({ renderingEngineId: ENGINE_ID, viewportId });
}

// ───────────────────────────── annotations ─────────────────────────────

export function clearAnnotations(engine: Engine, element?: HTMLDivElement | null): void {
  const { annotation } = engine.tools;
  if (element) {
    const all = annotation.state.getAllAnnotations();
    const { getEnabledElement } = engine.core;
    const enabled = getEnabledElement(element);
    const frameOfReference = enabled?.FrameOfReferenceUID;
    for (const a of all) {
      if (!frameOfReference || a.metadata?.FrameOfReferenceUID === frameOfReference) {
        if (a.annotationUID) annotation.state.removeAnnotation(a.annotationUID);
      }
    }
  } else {
    annotation.state.removeAllAnnotations();
  }
  engine.renderingEngine.render();
}

export function undoLastAnnotation(engine: Engine): void {
  const { annotation } = engine.tools;
  const all = annotation.state.getAllAnnotations();
  const last = all[all.length - 1];
  if (last?.annotationUID) annotation.state.removeAnnotation(last.annotationUID);
  engine.renderingEngine.render();
}

// ───────────────────────────── volume groups ─────────────────────────────

const PLANE_COLORS: Record<string, string> = {
  "vol-axial": "rgb(240, 90, 80)",
  "vol-coronal": "rgb(52, 199, 120)",
  "vol-sagittal": "rgb(110, 160, 255)",
};

/**
 * MPR planes: crosshairs on the left button (drag the centre to move, the
 * lines to rotate an oblique, the handles for slab thickness), wheel = slice,
 * right = window, middle = pan, Ctrl+wheel = zoom.
 * 3D: rotate on the left, zoom on the right, pan on the middle.
 */
export function ensureVolumeGroups(engine: Engine): void {
  const { tools } = engine;
  const { MouseBindings, KeyboardBindings } = bindingsFor(engine);
  if (!tools.ToolGroupManager.getToolGroup(MPR_GROUP)) {
    const g = tools.ToolGroupManager.createToolGroup(MPR_GROUP)!;
    g.addTool("Crosshairs", {
      getReferenceLineColor: (viewportId: string) => PLANE_COLORS[viewportId] ?? "rgb(240, 176, 64)",
      getReferenceLineControllable: () => true,
      getReferenceLineDraggableRotatable: () => true,
      getReferenceLineSlabThicknessControlsOn: () => true,
      mobile: { enabled: false },
    });
    for (const name of ["StackScroll", "WindowLevel", "Pan", "Zoom", "Length", "EllipticalROI", "Probe"]) g.addTool(name);
    g.setToolActive("Crosshairs", { bindings: [{ mouseButton: MouseBindings.Primary }] });
    g.setToolActive("StackScroll", { bindings: [{ mouseButton: MouseBindings.Wheel }] });
    g.setToolActive("WindowLevel", { bindings: [{ mouseButton: MouseBindings.Secondary }] });
    g.setToolActive("Pan", { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
    g.setToolActive("Zoom", { bindings: [{ mouseButton: MouseBindings.Wheel, modifierKey: KeyboardBindings.Ctrl }] });
    for (const name of ["Length", "EllipticalROI", "Probe"]) g.setToolPassive(name);
    leftByGroup.set(MPR_GROUP, "Crosshairs");
  }
  if (!tools.ToolGroupManager.getToolGroup(MIP_GROUP)) {
    const g = tools.ToolGroupManager.createToolGroup(MIP_GROUP)!;
    for (const name of ["WindowLevel", "Pan", "Zoom"]) g.addTool(name);
    g.setToolActive("WindowLevel", { bindings: [{ mouseButton: MouseBindings.Primary }, { mouseButton: MouseBindings.Secondary }] });
    g.setToolActive("Pan", { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
    g.setToolActive("Zoom", { bindings: [{ mouseButton: MouseBindings.Wheel }] });
  }
  if (!tools.ToolGroupManager.getToolGroup(VR_GROUP)) {
    const g = tools.ToolGroupManager.createToolGroup(VR_GROUP)!;
    for (const name of ["TrackballRotate", "Zoom", "Pan"]) g.addTool(name);
    g.setToolActive("TrackballRotate", { bindings: [{ mouseButton: MouseBindings.Primary }] });
    g.setToolActive("Zoom", { bindings: [{ mouseButton: MouseBindings.Secondary }, { mouseButton: MouseBindings.Wheel }] });
    g.setToolActive("Pan", { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
  }
}

/** Volume ids currently held, so a new MPR releases the previous volume's memory. */
const heldVolumes = new Set<string>();

export function holdVolumes(engine: Engine, keep: string[]): void {
  for (const id of [...heldVolumes]) {
    if (!keep.includes(id)) {
      try {
        engine.core.cache.removeVolumeLoadObject(id);
      } catch {
        /* already evicted */
      }
      heldVolumes.delete(id);
    }
  }
  keep.forEach((id) => heldVolumes.add(id));
}
