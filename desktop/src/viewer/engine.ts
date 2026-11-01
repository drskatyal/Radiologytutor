// Cornerstone3D, initialised once for the whole window.
//
// One RenderingEngine drives every viewport (a second engine allocates a
// second WebGL context pool — see the note in components/CornerstoneViewer).
// Engine knobs come from `lib/viewerRuntime.ts`, the same functions the web
// viewer and the benchmark harness use.
//
// The engine is imported lazily: nothing of Cornerstone loads until the reader
// opens something (cold start budget < 0.5 s). Its modules are pre-warmed only
// on intent: hovering a recent study, or dragging files over the window.

import {
  coreInitConfig,
  detectDeviceProfile,
  imageCacheBytes,
  retrievalPoolSizes,
} from "@flowrad/viewer-core";
// Same copy Cornerstone's worker manager uses (hoisted root dependency): its
// releaseProxy symbol must match when the manager terminates our workers.
import * as Comlink from "comlink";
import { decodePoolSize, installLazyWorkerPool, type PoolHandle } from "./workerPool";
import { tuneStackScrollTool } from "@flowrad/viewer-core";
import { installDatasetTrim } from "./memory";
import { nearestIndex, positionsAlong, sliceNormalOf, syncTargetIndex, type SyncStack } from "@flowrad/viewer-core";

/** Decoded-image budget: holds a 1,500-slice 512² CT, or a 2,000-slice 256² MR, with room for an MPR. */
const MB = 1024 * 1024;
/**
 * Decoded-image budget while reading in 2D: the slices around the reader and a
 * few series. Kept small because it is what a CT left open costs at idle (HP:
 * ~1.1 GB with the old 1 GB budget; the idle target is 400 MB for the whole
 * process tree). ~300 CT slices of 512²: a ±N window plus recent series, not
 * the study; the ±N travel prefetch (StackViewport) refills it ahead. MPR / 3D raise it to fit their volume for
 * as long as the volume is open (enterVolumeMemory / leaveVolumeMemory).
 */
const BROWSE_CACHE_BUDGET = 160 * MB;
let deviceCacheCeiling = 1024 * MB;

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
let workerPool: PoolHandle | null = null;

/** Live decode workers and a way to free the idle ones (memory HUD, teardown). */
export function decodeWorkers(): { live: number; releaseIdle(): void } {
  return { live: workerPool?.live() ?? 0, releaseIdle: () => workerPool?.releaseIdle() };
}

/** Start loading the engine chunks without initialising (idle pre-warm). */
export function prewarmEngine(): void {
  void import("@cornerstonejs/core");
  void import("@cornerstonejs/tools");
  void import("@cornerstonejs/dicom-image-loader");
}

/** Wall-clock cost of the last engine init, for the benchmark report. */
export const engineTimings: {
  initMs?: number;
  startAt?: number;
  readyAt?: number;
  /** Split of initMs: module import/parse, core+tools init, loader init. */
  steps?: Record<string, number>;
} = {};

let engineReady: Engine | null = null;
/** The engine if it is already initialised, without starting it. */
export function enginePeek(): Engine | null {
  return engineReady;
}

export function getEngine(): Promise<Engine> {
  if (!enginePromise) {
    const t0 = performance.now();
    engineTimings.startAt = t0;
    enginePromise = createEngine().then((e) => {
      engineTimings.readyAt = performance.now();
      engineTimings.initMs = engineTimings.readyAt - t0;
      engineReady = e;
      return e;
    });
  }
  return enginePromise;
}

async function createEngine(): Promise<Engine> {
  const steps: Record<string, number> = {};
  engineTimings.steps = steps;
  let mark = performance.now();
  const step = (name: string) => {
    const now = performance.now();
    steps[name] = Math.round(now - mark);
    mark = now;
  };
  const [core, tools, loader] = await Promise.all([
    import("@cornerstonejs/core"),
    import("@cornerstonejs/tools"),
    import("@cornerstonejs/dicom-image-loader"),
  ]);
  step("importMs");
  const profile = detectDeviceProfile();
  // Desktop: never the mobile profile, whatever the pointer says.
  profile.isMobile = false;
  const config = coreInitConfig(profile) as unknown as { rendering: Record<string, unknown> };
  // One WebGL context instead of Cornerstone's pool of seven: each context
  // that shows a volume uploads its own copy of the volume texture, and the
  // MPR panes landed in different contexts (WebView2 GPU process: ~3x the
  // texture size). One context shares one texture across every pane.
  config.rendering.webGlContextCount = 1;
  await core.init(config as unknown as Parameters<typeof core.init>[0]);
  await tools.init();
  step("coreToolsInitMs");
  // ONE worker at init (the loader would otherwise spawn every instance up
  // front and never free them); workerPool.ts widens it to a lazy pool of
  // cores − 2 that spawns on demand and reaps idle workers.
  // Legacy dataset path: the metadata tags are read from a dicom-parser dataset
  // that memory.ts trims to its header after decode. The default (naturalized)
  // path pins every file's full bytes in a metadata store for the session.
  await loader.init({
    maxWebWorkers: 1,
    useLegacyMetadataProvider: true,
  } as Parameters<typeof loader.init>[0]);
  workerPool = installLazyWorkerPool(
    (core as unknown as { getWebWorkerManager(): unknown }).getWebWorkerManager(),
    "dicomImageLoader",
    decodePoolSize(profile.cores),
    (w) => Comlink.wrap(w)
  );
  installDatasetTrim(core, loader);
  step("loaderInitMs");
  try {
    // Honest now that raw file bytes are released after decode (memory.ts):
    // this budget is close to what the decoded images really hold. LRU
    // eviction keeps a long session from growing past it.
    deviceCacheCeiling = Math.max(BROWSE_CACHE_BUDGET, imageCacheBytes(profile));
    core.cache.setMaxCacheSize(Math.min(deviceCacheCeiling, BROWSE_CACHE_BUDGET));
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
  step("toolsAndEngineMs");
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
  if (kind === "slice") {
    // Anatomy, not slice number: nearest slice by patient position (+ prior
    // registration offset); stack fraction when positions are missing.
    return engine.tools.SynchronizerManager.createSynchronizer(
      SYNC_IDS[kind],
      engine.core.Enums.Events.STACK_NEW_IMAGE,
      (_sync: unknown, source: ViewportRef, target: ViewportRef) => syncSlice(engine, source, target)
    );
  }
  if (kind === "voi") return synchronizers.createVOISynchronizer(SYNC_IDS[kind], { syncInvertState: true, syncColormap: false });
  return synchronizers.createZoomPanSynchronizer(SYNC_IDS[kind]);
}

type ViewportRef = { renderingEngineId: string; viewportId: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyViewport = any;

/** Registration offsets (mm) by a stack's first imageId: prior studies. */
const stackOffsets = new Map<string, number>();
export function setStackOffset(firstImageId: string, offsetMm: number | null): void {
  if (offsetMm == null) stackOffsets.delete(firstImageId);
  else stackOffsets.set(firstImageId, offsetMm);
}

/**
 * Slice geometry by imageId, from the shell's header scan. Cornerstone's
 * metadata only knows slices it has already loaded, so sync and the 3D
 * cursor read positions from here (every slice, from the moment of opening).
 */
const geometry = new Map<string, { ipp?: readonly number[]; iop?: readonly number[] }>();
export function registerGeometry(imageIds: readonly string[], planes: readonly { imagePositionPatient?: readonly number[]; imageOrientationPatient?: readonly number[] }[]): void {
  imageIds.forEach((id, i) => geometry.set(id, { ipp: planes[i]?.imagePositionPatient, iop: planes[i]?.imageOrientationPatient }));
}

const syncStacks = new WeakMap<readonly string[], SyncStack>();
function syncStackOf(engine: Engine, vp: AnyViewport): SyncStack | null {
  const ids: string[] | undefined = vp?.getImageIds?.();
  if (!ids?.length) return null;
  let stack = syncStacks.get(ids);
  if (!stack) {
    const planes = ids.map((id) => {
      const known = geometry.get(id);
      if (known?.ipp) return known;
      const m = engine.core.metaData.get("imagePlaneModule", id) as { imagePositionPatient?: number[]; rowCosines?: number[]; columnCosines?: number[] } | undefined;
      return { ipp: m?.imagePositionPatient, iop: m?.rowCosines && m?.columnCosines ? [...m.rowCosines, ...m.columnCosines] : undefined };
    });
    const normal = sliceNormalOf(planes.find((p) => p.iop)?.iop);
    stack = {
      positions: normal ? positionsAlong(planes.map((p) => p.ipp), normal) : ids.map(() => Number.NaN),
      normal,
    };
    // Cache only complete geometry; a partial one is rebuilt next time.
    if (stack.positions.every(Number.isFinite)) syncStacks.set(ids, stack);
  }
  return { ...stack, offsetMm: stackOffsets.get(ids[0]) ?? 0 };
}

function syncSlice(engine: Engine, source: ViewportRef, target: ViewportRef): void {
  const re = engine.renderingEngine;
  const s = re.getViewport(source.viewportId);
  const t = re.getViewport(target.viewportId);
  const sStack = syncStackOf(engine, s);
  const tStack = syncStackOf(engine, t);
  if (!sStack || !tStack) return;
  const index = syncTargetIndex(sStack, s.getCurrentImageIdIndex(), tStack);
  if (index >= 0 && index !== t.getCurrentImageIdIndex()) void t.setImageIdIndex(index);
}

/**
 * "Link at the current position": treat what each viewport shows right now as
 * the same anatomy. Sets each stack's registration offset relative to
 * `referenceId`, so turning sync on after lining a prior up by eye keeps them
 * aligned (the standard PACS way to register a follow-up).
 */
export function linkStacksAtCurrent(engine: Engine, viewportIds: string[], referenceId: string): void {
  const re = engine.renderingEngine;
  const ref = re.getViewport(referenceId) as AnyViewport;
  const refStack = syncStackOf(engine, ref);
  if (!refStack) return;
  const zRef = refStack.positions[ref.getCurrentImageIdIndex()] + (refStack.offsetMm ?? 0);
  if (!Number.isFinite(zRef)) return;
  for (const id of viewportIds) {
    if (id === referenceId) continue;
    const vp = re.getViewport(id) as AnyViewport;
    const stack = syncStackOf(engine, vp);
    const z = stack?.positions[vp.getCurrentImageIdIndex()];
    const first = vp?.getImageIds?.()[0];
    if (!first || !Number.isFinite(z)) continue;
    setStackOffset(first, zRef - (z as number));
  }
}

/**
 * 3D cursor: send every other stack viewport in the same frame of reference
 * to the slice nearest `world` (mm, patient). Returns how many moved.
 */
export function jumpTo3dPoint(engine: Engine, sourceViewportId: string, world: readonly number[]): number {
  const source = engine.renderingEngine.getViewport(sourceViewportId);
  const frame = source?.getFrameOfReferenceUID?.();
  let moved = 0;
  for (const vp of engine.renderingEngine.getViewports() as AnyViewport[]) {
    if (vp.id === sourceViewportId || !vp.getImageIds || vp.getFrameOfReferenceUID?.() !== frame) continue;
    const stack = syncStackOf(engine, vp);
    if (!stack?.normal || !stack.positions.some(Number.isFinite)) continue;
    const z = world[0] * stack.normal[0] + world[1] * stack.normal[1] + world[2] * stack.normal[2];
    const index = nearestIndex(stack.positions, z);
    if (index >= 0 && index !== vp.getCurrentImageIdIndex()) {
      void vp.setImageIdIndex(index);
      moved += 1;
    }
  }
  return moved;
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

/**
 * Before a volume (MPR, 3D, fusion) loads: drop every decoded image that is not
 * one of its slices (other series, thumbnails' neighbours, the 2D prefetch) and
 * raise the budget to fit the volume, so its slices are the only pixels held.
 * The volume is backed by those cached slices, so this IS the "free the 2D
 * cache once the volume exists" step: nothing is held twice.
 */
export function enterVolumeMemory(engine: Engine, imageIds: readonly string[], bytesPerImage: number): void {
  const cache = engine.core.cache as unknown as {
    _imageCache: Map<string, { sharedCacheKey?: string }>;
    removeImageLoadObject: (id: string, opts?: { force?: boolean }) => void;
    setMaxCacheSize: (n: number) => void;
  };
  const keep = new Set(imageIds);
  for (const id of [...cache._imageCache.keys()]) {
    if (keep.has(id)) continue;
    try {
      cache.removeImageLoadObject(id, { force: true });
      engine.core.triggerEvent(engine.core.eventTarget, engine.core.Enums.Events.IMAGE_CACHE_IMAGE_REMOVED, { imageId: id });
    } catch {
      /* already gone */
    }
  }
  const need = Math.ceil(imageIds.length * bytesPerImage * 1.05) + 32 * MB;
  cache.setMaxCacheSize(Math.min(deviceCacheCeiling, Math.max(BROWSE_CACHE_BUDGET, need)));
}

/** Back to 2D: release volumes and return to the browsing budget. */
export function leaveVolumeMemory(engine: Engine): void {
  holdVolumes(engine, []);
  // The volume load ran every decode worker; free the idle ones now.
  workerPool?.releaseIdle();
  const cache = engine.core.cache as unknown as {
    setMaxCacheSize: (n: number) => void;
    decacheIfNecessaryUntilBytesAvailable: (n: number) => void;
  };
  cache.setMaxCacheSize(Math.min(deviceCacheCeiling, BROWSE_CACHE_BUDGET));
  try {
    cache.decacheIfNecessaryUntilBytesAvailable(0);
  } catch {
    /* nothing to evict */
  }
}
