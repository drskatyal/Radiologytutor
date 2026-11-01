// Cornerstone volume MPR. Imported only after the user turns MPR on, so the
// stack viewport's first pixel does not wait on a volume load.
//
// The streaming volume shell is created from imageIds the stack already
// cached. volume.load() then fills slices in the background. Window/level is
// one synchronizer across the three planes. Crosshairs stay passive: scroll
// and pan move the cameras, and the tool redraws the intersection.

import {
  MIP_SLAB_MM,
  MPR_REFERENCE_LINE,
  cameraLookingAt,
  mprVolumeId,
  mprVolumeKey,
  mprViewportIds,
  sliceCenterPatient,
  type MprSessionHandle,
  type PlaneSample,
} from "./mpr";
import { tuneStackScrollTool } from "./scrollSensitivity";
import { voiToWwWc, wwWcToVoi } from "./viewportVoi";

type Camera = {
  focalPoint?: number[];
  position?: number[];
  viewPlaneNormal?: number[];
  viewUp?: number[];
};

type VolumeViewportLike = {
  id?: string;
  element?: HTMLDivElement;
  render: () => void;
  resetCamera: (options?: {
    resetPan?: boolean;
    resetZoom?: boolean;
    resetToCenter?: boolean;
    resetRotation?: boolean;
    suppressEvents?: boolean;
  }) => boolean | void;
  resetProperties?: () => void;
  getCamera: () => Camera;
  setCamera: (camera: Camera) => void;
  getProperties?: () => { voiRange?: { lower: number; upper: number } };
  setProperties: (
    props: { voiRange?: { lower: number; upper: number }; invert?: boolean },
    volumeId?: string,
    suppressEvents?: boolean
  ) => void;
  getCurrentImageId?: () => string | undefined;
};

export interface MountMprArgs {
  renderingEngineId: string;
  instanceId: string;
  elements: {
    axial: HTMLDivElement;
    coronal: HTMLDivElement;
    sagittal: HTMLDivElement;
    /** Host for the 3D render. Enabled only when 3D is chosen. */
    volume3d?: HTMLDivElement | null;
  };
  /** CT gets a bone preset in 3D; anything else a soft MR preset. */
  modality?: string | null;
  imageIds: string[];
  /** Stack image to center on. Skipped when that image has no plane anchor. */
  initialImageId?: string;
  voi?: { ww: number; wc: number } | null;
  invert?: boolean;
  leftTool?: string;
  /** Fired when the axial plane scrolls onto a different cached image. */
  onAxialImage?: (imageId: string) => void;
  /** Fired when a plane's window changes (a drag, not a suppressed write). */
  onVoi?: (ww: number, wc: number) => void;
  readPlane: (imageId: string) => PlaneSample | null;
}

// Crosshairs leads: in MPR the left button moves the shared centre, so a
// click in one plane drives the other two (the "linked" views a reader
// expects). Window/level stays on the toolbar and the keyboard.
const NAV_TOOLS = ["Crosshairs", "WindowLevel", "Pan", "Zoom", "StackScroll"] as const;

export async function mountMprSession(args: MountMprArgs): Promise<MprSessionHandle> {
  const core = await import("@cornerstonejs/core");
  const tools = await import("@cornerstonejs/tools");
  const ids = mprViewportIds(args.instanceId);
  const engine = core.getRenderingEngine(args.renderingEngineId);
  if (!engine) throw new Error("Viewer rendering engine is not available");
  const viewportOf = (viewportId: string) =>
    engine.getViewport(viewportId) as VolumeViewportLike | undefined;

  const planes = [
    ["axial", ids.axial, core.Enums.OrientationAxis.AXIAL],
    ["coronal", ids.coronal, core.Enums.OrientationAxis.CORONAL],
    ["sagittal", ids.sagittal, core.Enums.OrientationAxis.SAGITTAL],
  ] as const;

  for (const [plane, viewportId, orientation] of planes) {
    const existing = viewportOf(viewportId);
    if (existing) {
      try {
        engine.disableElement(viewportId);
      } catch {
        /* replaced below */
      }
    }
    engine.enableElement({
      viewportId,
      type: core.Enums.ViewportType.ORTHOGRAPHIC,
      element: args.elements[plane],
      defaultOptions: {
        orientation,
        background: [0, 0, 0],
      },
    });
  }

  let volumeKey = mprVolumeKey(args.imageIds);
  let volumeId = mprVolumeId(args.instanceId, args.imageIds);
  let ignoreAxial = false;
  let disposed = false;

  const viewportIds = [ids.axial, ids.coronal, ids.sagittal];
  const viewports = () =>
    viewportIds
      .map((id) => viewportOf(id))
      .filter((vp): vp is VolumeViewportLike => Boolean(vp));

  const releaseVolume = (id: string) => {
    try {
      const cached = core.cache.getVolume(id) as { cancelLoading?: () => void } | undefined;
      cached?.cancelLoading?.();
    } catch {
      /* already gone */
    }
    try {
      if (core.cache.getVolumeLoadObject(id)) core.cache.removeVolumeLoadObject(id);
    } catch {
      /* not cached */
    }
  };

  const jumpToImageId = (imageId: string): boolean => {
    if (disposed || !imageId) return false;
    let plane: PlaneSample | null = null;
    try {
      plane = args.readPlane(imageId);
    } catch {
      plane = null;
    }
    const center = sliceCenterPatient(plane);
    if (!center) return false;
    ignoreAxial = true;
    try {
      for (const vp of viewports()) {
        const camera = vp.getCamera();
        const next = cameraLookingAt(camera, center);
        if (!next) return false;
        vp.setCamera({
          ...camera,
          focalPoint: [...next.focalPoint],
          position: [...next.position],
        });
        vp.render();
      }
      const group = tools.ToolGroupManager.getToolGroup(ids.toolGroupId);
      const crosshairs = group?.getToolInstance?.("Crosshairs") as
        | { computeToolCenter?: () => void }
        | undefined;
      crosshairs?.computeToolCenter?.();
      return true;
    } finally {
      queueMicrotask(() => {
        ignoreAxial = false;
      });
    }
  };

  const setVoi = (ww: number, wc: number) => {
    if (disposed) return;
    const voiRange = wwWcToVoi(ww, wc);
    for (const vp of viewports()) {
      try {
        vp.setProperties({ voiRange }, volumeId, true);
        vp.render();
      } catch {
        /* actor not ready yet */
      }
    }
  };

  const setInvert = (value: boolean) => {
    if (disposed) return;
    for (const vp of viewports()) {
      try {
        vp.setProperties({ invert: value });
        vp.render();
      } catch {
        /* actor not ready yet */
      }
    }
  };

  const loadVolume = async (imageIds: string[], imageId?: string, voi?: { ww: number; wc: number } | null) => {
    const nextKey = mprVolumeKey(imageIds);
    const nextId = mprVolumeId(args.instanceId, imageIds);
    const previous = volumeId;
    const volume = await core.volumeLoader.createAndCacheVolume(nextId, { imageIds });
    // Stream slices. The shell is enough for setVolumes; pixels arrive after.
    try {
      volume.load();
    } catch {
      /* a failed frame is reported by the loader; the planes stay up */
    }
    await core.setVolumesForViewports(
      engine,
      [{ volumeId: nextId }],
      viewportIds,
      true
    );
    volumeKey = nextKey;
    volumeId = nextId;
    try {
      engine.resize(true, true);
    } catch {
      /* first layout may still be settling */
    }
    for (const vp of viewports()) {
      try {
        vp.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true });
      } catch {
        /* orientation camera is already set */
      }
    }
    if (imageId) jumpToImageId(imageId);
    if (voi && voi.ww > 0) setVoi(voi.ww, voi.wc);
    engine.renderViewports?.(viewportIds);
    if (previous !== nextId) releaseVolume(previous);
  };

  await loadVolume(args.imageIds, args.initialImageId, args.voi);

  const {
    addTool,
    ToolGroupManager,
    SynchronizerManager,
    CrosshairsTool,
    WindowLevelTool,
    PanTool,
    ZoomTool,
    StackScrollTool,
    Enums: toolEnums,
    synchronizers,
  } = tools;

  for (const Tool of [CrosshairsTool, WindowLevelTool, PanTool, ZoomTool, StackScrollTool]) {
    try {
      addTool(Tool);
    } catch {
      /* registered by the stack viewport */
    }
  }

  try {
    ToolGroupManager.destroyToolGroup(ids.toolGroupId);
  } catch {
    /* none yet */
  }
  const group = ToolGroupManager.createToolGroup(ids.toolGroupId);
  if (!group) throw new Error("Could not create the MPR tool group");

  const lineColor = (viewportId: string) => {
    if (viewportId === ids.axial) return MPR_REFERENCE_LINE.axial;
    if (viewportId === ids.coronal) return MPR_REFERENCE_LINE.coronal;
    if (viewportId === ids.sagittal) return MPR_REFERENCE_LINE.sagittal;
    return "rgb(200, 200, 200)";
  };
  group.addTool(CrosshairsTool.toolName, {
    getReferenceLineColor: lineColor,
    getReferenceLineControllable: () => true,
    // Must be true for the planes to LINK: CrosshairsTool._jump (click) and
    // the line drag only move viewports whose lines are controllable AND
    // draggable-rotatable. With false, clicks and drags in one plane never
    // moved the others. Rotation handles show only while a line is hovered.
    getReferenceLineDraggableRotatable: () => true,
    getReferenceLineSlabThicknessControlsOn: () => false,
  });
  for (const Tool of [WindowLevelTool, PanTool, ZoomTool, StackScrollTool]) {
    group.addTool(Tool.toolName);
  }
  for (const viewportId of viewportIds) group.addViewport(viewportId, args.renderingEngineId);

  const { MouseBindings } = toolEnums;
  group.setToolActive(StackScrollTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Wheel }],
  });
  tuneStackScrollTool(
    (group as { getToolInstance?: (name: string) => unknown }).getToolInstance?.(
      StackScrollTool.toolName
    )
  );
  group.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }],
  });
  group.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Auxiliary }],
  });

  let leftTool: string | null = null;
  const setLeftTool = (name: string) => {
    const next = (NAV_TOOLS as readonly string[]).includes(name) ? name : "Crosshairs";
    const primary = { mouseButton: MouseBindings.Primary };
    if (leftTool && leftTool !== next) {
      group.setToolPassive(leftTool, { removeAllBindings: [primary] });
    }
    group.setToolActive(next, { bindings: [primary] });
    leftTool = next;
    // Crosshairs off the left button still draw (passive) and follow scroll.
    if (next !== CrosshairsTool.toolName) group.setToolPassive(CrosshairsTool.toolName);
  };
  group.setToolPassive(CrosshairsTool.toolName);
  // A stack tool that has no meaning on a volume (Length, Probe…) falls to
  // crosshairs, which is what MPR is for.
  setLeftTool(args.leftTool && (NAV_TOOLS as readonly string[]).includes(args.leftTool) && args.leftTool !== "StackScroll" ? args.leftTool : "Crosshairs");

  try {
    SynchronizerManager.destroySynchronizer(ids.voiSyncId);
  } catch {
    /* none yet */
  }
  const voiSync = synchronizers.createVOISynchronizer(ids.voiSyncId, {
    syncInvertState: true,
    syncColormap: false,
  });
  for (const viewportId of viewportIds) {
    voiSync.add({ renderingEngineId: args.renderingEngineId, viewportId });
  }

  if (args.invert) setInvert(true);
  if (args.voi && args.voi.ww > 0) setVoi(args.voi.ww, args.voi.wc);

  const axial = args.elements.axial;
  const onCamera = () => {
    if (ignoreAxial || disposed || !args.onAxialImage) return;
    const vp = viewportOf(ids.axial);
    const imageId = vp?.getCurrentImageId?.();
    if (imageId) args.onAxialImage(imageId);
  };
  axial.addEventListener(core.Enums.Events.CAMERA_MODIFIED, onCamera);

  const voiElements = [args.elements.axial, args.elements.coronal, args.elements.sagittal];
  const onVoiEvent = () => {
    if (disposed || !args.onVoi) return;
    const range = viewportOf(ids.axial)?.getProperties?.().voiRange;
    const voi = range ? voiToWwWc(range) : null;
    if (voi) args.onVoi(voi.ww, voi.wc);
  };
  for (const element of voiElements) {
    element.addEventListener(core.Enums.Events.VOI_MODIFIED, onVoiEvent);
  }

  // --- MIP slab and 3D ------------------------------------------------------
  type BlendViewport = VolumeViewportLike & {
    setBlendMode?: (mode: number, filterActorUIDs?: string[], immediate?: boolean) => void;
    setSlabThickness?: (mm: number) => void;
    resetSlabThickness?: () => void;
  };
  const vrId = `${ids.axial}-3d`;
  const vrGroupId = `${ids.toolGroupId}-3d`;
  let render: "mpr" | "mip" | "3d" = "mpr";

  const disable3d = () => {
    try {
      ToolGroupManager.destroyToolGroup(vrGroupId);
    } catch {
      /* none */
    }
    try {
      if (engine.getViewport(vrId)) engine.disableElement(vrId);
    } catch {
      /* already gone */
    }
  };

  const setRender = async (mode: "mpr" | "mip" | "3d"): Promise<boolean> => {
    if (disposed) return false;
    const blend = core.Enums.BlendModes;
    if (mode === "3d") {
      const host = args.elements.volume3d;
      if (!host) return false;
      try {
        if (!engine.getViewport(vrId)) {
          engine.enableElement({
            viewportId: vrId,
            type: core.Enums.ViewportType.VOLUME_3D,
            element: host,
            defaultOptions: { background: [0, 0, 0] },
          });
          await core.setVolumesForViewports(engine, [{ volumeId }], [vrId], true);
          const vr = engine.getViewport(vrId) as unknown as {
            setProperties: (p: { preset?: string }) => void;
            resetCamera: () => void;
            render: () => void;
          };
          const ct = (args.modality ?? "").toUpperCase() === "CT";
          vr.setProperties({ preset: ct ? "CT-Bone" : "MR-Default" });
          vr.resetCamera();
          const { TrackballRotateTool } = tools;
          try {
            addTool(TrackballRotateTool);
          } catch {
            /* registered */
          }
          const vrGroup = ToolGroupManager.createToolGroup(vrGroupId);
          if (vrGroup) {
            vrGroup.addTool(TrackballRotateTool.toolName);
            vrGroup.addTool(ZoomTool.toolName);
            vrGroup.addTool(PanTool.toolName);
            vrGroup.addViewport(vrId, args.renderingEngineId);
            vrGroup.setToolActive(TrackballRotateTool.toolName, {
              bindings: [{ mouseButton: MouseBindings.Primary }, { numTouchPoints: 1 }],
            });
            vrGroup.setToolActive(ZoomTool.toolName, {
              bindings: [{ mouseButton: MouseBindings.Secondary }, { mouseButton: MouseBindings.Wheel }, { numTouchPoints: 2 }],
            });
            vrGroup.setToolActive(PanTool.toolName, {
              bindings: [{ mouseButton: MouseBindings.Auxiliary }],
            });
          }
          engine.resize(true, true);
          vr.render();
        }
        render = "3d";
        return true;
      } catch (err) {
        console.warn("Viewer 3D render unavailable", err);
        disable3d();
        return false;
      }
    }
    // Leaving 3D frees its WebGL work.
    if (render === "3d") disable3d();
    for (const vp of viewports() as BlendViewport[]) {
      try {
        if (mode === "mip") {
          vp.setBlendMode?.(blend.MAXIMUM_INTENSITY_BLEND);
          vp.setSlabThickness?.(MIP_SLAB_MM);
        } else {
          vp.setBlendMode?.(blend.COMPOSITE);
          if (vp.resetSlabThickness) vp.resetSlabThickness();
          else vp.setSlabThickness?.(0.1);
        }
        vp.render();
      } catch {
        /* actor not ready yet */
      }
    }
    render = mode;
    return true;
  };

  const scrollPlane = (plane: "axial" | "coronal" | "sagittal", delta: number) => {
    if (disposed || !delta) return;
    const vp = viewportOf(ids[plane]);
    if (!vp) return;
    try {
      core.utilities.scroll(vp as unknown as Parameters<typeof core.utilities.scroll>[0], {
        delta,
        volumeId,
      });
    } catch {
      /* camera not ready */
    }
  };

  const destroy = () => {
    if (disposed) return;
    disposed = true;
    disable3d();
    axial.removeEventListener(core.Enums.Events.CAMERA_MODIFIED, onCamera);
    for (const element of voiElements) {
      element.removeEventListener(core.Enums.Events.VOI_MODIFIED, onVoiEvent);
    }
    try {
      SynchronizerManager.destroySynchronizer(ids.voiSyncId);
    } catch {
      /* already gone */
    }
    try {
      ToolGroupManager.destroyToolGroup(ids.toolGroupId);
    } catch {
      /* already gone */
    }
    for (const viewportId of viewportIds) {
      try {
        if (viewportOf(viewportId)) engine.disableElement(viewportId);
      } catch {
        /* already gone */
      }
    }
    releaseVolume(volumeId);
  };

  return {
    get volumeKey() {
      return volumeKey;
    },
    destroy,
    replace: async (imageIds, imageId, voi) => {
      if (disposed) return;
      await loadVolume(imageIds, imageId, voi);
    },
    jumpToImageId,
    setVoi,
    setInvert,
    resetView: () => {
      const groupNow = tools.ToolGroupManager.getToolGroup(ids.toolGroupId);
      const crosshairs = groupNow?.getToolInstance?.("Crosshairs") as
        | { resetCrosshairs?: () => void }
        | undefined;
      try {
        crosshairs?.resetCrosshairs?.();
      } catch {
        for (const vp of viewports()) {
          try {
            vp.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true, resetRotation: true });
          } catch {
            /* viewport already disabled */
          }
        }
      }
      for (const vp of viewports()) {
        try {
          vp.resetProperties?.();
          vp.render();
        } catch {
          /* viewport already disabled */
        }
      }
    },
    resize: () => {
      try {
        engine.resize(true, true);
      } catch {
        /* engine torn down */
      }
    },
    setLeftTool,
    restoreCrosshairs: () => {
      const groupNow = tools.ToolGroupManager.getToolGroup(ids.toolGroupId);
      const crosshairs = groupNow?.getToolInstance?.("Crosshairs") as
        | { computeToolCenter?: () => void }
        | undefined;
      crosshairs?.computeToolCenter?.();
    },
    setRender,
    scrollPlane,
  };
}
