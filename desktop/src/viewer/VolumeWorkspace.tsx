// MPR, 3D volume rendering and PET/CT fusion.
//
//   mpr     axial · sagittal · coronal with linked crosshairs (a 3D cursor:
//           click anywhere and the other planes jump there), oblique by
//           dragging a line, slab MIP / MinIP / average, plus a 3D view.
//   3d      one large volume rendering with Cornerstone's VR presets.
//   fusion  CT with a PET overlay (SUVbw when the dose tags allow) in three
//           planes, and a coronal PET MIP.
//
// The volume streams in: planes are live as soon as the shell exists and fill
// as slices decode. One volume is held at a time (`holdVolumes`).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Hand, RotateCcw, Ruler, Circle, SunMedium, ZoomIn, Pipette, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { mprVolumeId } from "@/lib/mpr";
import type { ViewerSeries, ViewerStudy } from "../types";
import { formatPersonName } from "../study";
import {
  ENGINE_ID,
  ensureVolumeGroups,
  getEngine,
  holdVolumes,
  MIP_GROUP,
  MPR_GROUP,
  removeViewportFromGroups,
  setGroupLeftTool,
  VR_GROUP,
  type Engine,
} from "./engine";
import { edgeLabels, type EdgeLabels, type Vec3 } from "./orientation";
import { voiRangeOf, windowPresetsFor, wwwcOf } from "./presets";
import { ensureSuv } from "./suv";

export type VolumeMode = "mpr" | "3d" | "fusion";

type Blend = "composite" | "mip" | "minip" | "avg";

const VR_PRESETS = [
  "CT-Bone",
  "CT-Chest-Contrast-Enhanced",
  "CT-Soft-Tissue",
  "CT-Lung",
  "CT-AAA",
  "CT-Cardiac",
  "CT-MIP",
  "CT-Muscle",
  "MR-Default",
  "MR-Angio",
  "MR-MIP",
];
const PET_COLORMAPS = ["hsv", "Hot Iron", "jet", "Black-Body Radiation"];

interface Props {
  mode: VolumeMode;
  series: ViewerSeries;
  study: ViewerStudy | null;
  /** Fusion only: the PET series overlaid on `series`. */
  petSeries?: ViewerSeries | null;
  showOverlay: boolean;
  onExit: () => void;
  onVolumeReady?: (ms: { shellMs: number; loadedMs: number }) => void;
}

interface Pane {
  id: string;
  label: string;
  kind: "ortho" | "3d";
  orientation?: "AXIAL" | "SAGITTAL" | "CORONAL";
  /** Fusion: show only the PET volume, as a MIP. */
  petMip?: boolean;
}

function panesFor(mode: VolumeMode): Pane[] {
  if (mode === "3d") return [{ id: "vol-3d", label: "3D", kind: "3d" }];
  if (mode === "fusion")
    return [
      { id: "vol-axial", label: "Axial · fused", kind: "ortho", orientation: "AXIAL" },
      { id: "vol-coronal", label: "Coronal · fused", kind: "ortho", orientation: "CORONAL" },
      { id: "vol-sagittal", label: "Sagittal · fused", kind: "ortho", orientation: "SAGITTAL" },
      { id: "vol-petmip", label: "PET MIP", kind: "ortho", orientation: "CORONAL", petMip: true },
    ];
  return [
    { id: "vol-axial", label: "Axial", kind: "ortho", orientation: "AXIAL" },
    { id: "vol-sagittal", label: "Sagittal", kind: "ortho", orientation: "SAGITTAL" },
    { id: "vol-coronal", label: "Coronal", kind: "ortho", orientation: "CORONAL" },
    { id: "vol-3d", label: "3D", kind: "3d" },
  ];
}

interface PaneReadout {
  ww?: number;
  wc?: number;
  edges?: EdgeLabels;
}

export function VolumeWorkspace({ mode, series, study, petSeries, showOverlay, onExit, onVolumeReady }: Props) {
  const panes = useMemo(() => panesFor(mode), [mode]);
  const elements = useRef<Record<string, HTMLDivElement | null>>({});
  const engineRef = useRef<Engine | null>(null);
  const ctVolumeId = useMemo(() => mprVolumeId("desktop-ct", series.imageIds), [series.imageIds]);
  const ptVolumeId = useMemo(
    () => (petSeries ? mprVolumeId("desktop-pt", petSeries.imageIds) : null),
    [petSeries]
  );
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [blend, setBlend] = useState<Blend>("composite");
  const [slab, setSlab] = useState(0);
  const [vrPreset, setVrPreset] = useState(series.modality === "MR" ? "MR-Default" : "CT-Bone");
  const [colormap, setColormap] = useState("hsv");
  const [opacity, setOpacity] = useState(0.55);
  const [suvMax, setSuvMax] = useState(6);
  const [suvState, setSuvState] = useState<"suv" | "raw">("raw");
  /** Raw PET (no dose tags): keep the auto window until the reader sets one. */
  const [maxTouched, setMaxTouched] = useState(false);
  const [leftTool, setLeftTool] = useState("Crosshairs");
  const [readouts, setReadouts] = useState<Record<string, PaneReadout>>({});
  const presets = windowPresetsFor(series.modality);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vp = useCallback((id: string): any => {
    try {
      return engineRef.current?.renderingEngine.getViewport(id) ?? null;
    } catch {
      return null;
    }
  }, []);
  const orthoIds = panes.filter((p) => p.kind === "ortho" && !p.petMip).map((p) => p.id);

  const refresh = useCallback(
    (id: string) => {
      const v = vp(id);
      if (!v) return;
      const camera = v.getCamera?.();
      let voi: { ww: number; wc: number } | undefined;
      try {
        const range = v.getProperties?.(ctVolumeId)?.voiRange ?? v.getProperties?.()?.voiRange;
        if (range) voi = wwwcOf(range);
      } catch {
        /* 3D has no VOI */
      }
      setReadouts((r) => ({
        ...r,
        [id]: {
          ww: voi?.ww,
          wc: voi?.wc,
          edges: camera?.viewUp && camera?.viewPlaneNormal ? edgeLabels(camera.viewUp as Vec3, camera.viewPlaneNormal as Vec3) : undefined,
        },
      }));
    },
    [vp, ctVolumeId]
  );

  // Mount: volumes, viewports, tools.
  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const started = performance.now();
    (async () => {
      try {
        const engine = await getEngine();
        if (disposed) return;
        engineRef.current = engine;
        const { core, tools } = engine;
        ensureVolumeGroups(engine);
        if (petSeries) setSuvState(await ensureSuv(petSeries));

        const volume = await core.volumeLoader.createAndCacheVolume(ctVolumeId, { imageIds: series.imageIds });
        const ptVolume =
          petSeries && ptVolumeId
            ? await core.volumeLoader.createAndCacheVolume(ptVolumeId, { imageIds: petSeries.imageIds })
            : null;
        holdVolumes(engine, [ctVolumeId, ...(ptVolumeId ? [ptVolumeId] : [])]);
        if (disposed) return;

        const total = series.imageIds.length + (petSeries?.imageIds.length ?? 0);
        let loadedFrames = 0;
        const onModified = (e: Event) => {
          const d = (e as CustomEvent).detail as { volumeId?: string; framesProcessed?: number; numberOfFrames?: number };
          if (d?.volumeId !== ctVolumeId && d?.volumeId !== ptVolumeId) return;
          loadedFrames += 1;
          // Whole percents only: 1,200 slices must not mean 1,200 React renders.
          const pct = Math.floor((100 * loadedFrames) / total);
          if (pct !== Math.floor((100 * (loadedFrames - 1)) / total)) setProgress(Math.min(1, pct / 100));
        };
        core.eventTarget.addEventListener(core.Enums.Events.IMAGE_VOLUME_MODIFIED, onModified);
        cleanups.push(() => core.eventTarget.removeEventListener(core.Enums.Events.IMAGE_VOLUME_MODIFIED, onModified));

        for (const pane of panes) {
          const element = elements.current[pane.id];
          if (!element) continue;
          engine.renderingEngine.enableElement({
            viewportId: pane.id,
            element,
            type: pane.kind === "3d" ? core.Enums.ViewportType.VOLUME_3D : core.Enums.ViewportType.ORTHOGRAPHIC,
            defaultOptions: {
              background: [0, 0, 0],
              // 3D opens like a radiograph: from the front, head up.
              orientation: core.Enums.OrientationAxis[pane.orientation ?? "CORONAL"],
            },
          });
          const group = tools.ToolGroupManager.getToolGroup(pane.kind === "3d" ? VR_GROUP : pane.petMip ? MIP_GROUP : MPR_GROUP);
          group?.addViewport(pane.id, ENGINE_ID);
          const onCam = () => refresh(pane.id);
          element.addEventListener(core.Enums.Events.CAMERA_MODIFIED, onCam);
          element.addEventListener(core.Enums.Events.VOI_MODIFIED, onCam);
          cleanups.push(() => {
            element.removeEventListener(core.Enums.Events.CAMERA_MODIFIED, onCam);
            element.removeEventListener(core.Enums.Events.VOI_MODIFIED, onCam);
          });
        }

        // Fill the volume BEFORE attaching it. Attached volumes re-render every
        // pane (the 3D ray cast included) on each decoded slice: measured on
        // software GL, 300 slices took 67 s attached vs 1.9 s detached.
        const loadStarted = performance.now();
        await Promise.all([
          new Promise<void>((r) => (volume.load ? volume.load(() => r()) : r())),
          ptVolume ? new Promise<void>((r) => (ptVolume.load ? ptVolume.load(() => r()) : r())) : Promise.resolve(),
        ]);
        if (disposed) return;
        const loadMs = performance.now() - loadStarted;
        setProgress(1);

        const fused = panes.filter((p) => p.kind === "ortho" && !p.petMip).map((p) => p.id);
        const volumes = ptVolume
          ? [{ volumeId: ctVolumeId }, { volumeId: ptVolumeId! }]
          : [{ volumeId: ctVolumeId }];
        if (fused.length) await core.setVolumesForViewports(engine.renderingEngine, volumes, fused);
        const mip = panes.find((p) => p.petMip);
        if (mip && ptVolumeId) {
          await core.setVolumesForViewports(engine.renderingEngine, [{ volumeId: ptVolumeId }], [mip.id]);
        }
        const vr = panes.find((p) => p.kind === "3d");
        if (vr) {
          await core.setVolumesForViewports(engine.renderingEngine, [{ volumeId: ctVolumeId }], [vr.id]);
        }

        // Initial window / overlays.
        const h = series.headers[Math.floor(series.headers.length / 2)];
        for (const id of fused) {
          const v = vp(id);
          if (h?.windowWidth && h.windowWidth > 1 && h.windowCenter != null && series.modality !== "PT") {
            v?.setProperties({ voiRange: voiRangeOf(h.windowWidth, h.windowCenter) }, ctVolumeId);
          }
        }
        const voiSync = tools.synchronizers.createVOISynchronizer(`vol-voi-${Date.now()}`, {
          syncInvertState: true,
          syncColormap: false,
        });
        for (const id of fused) voiSync.add({ renderingEngineId: ENGINE_ID, viewportId: id });
        cleanups.push(() => tools.SynchronizerManager.destroySynchronizer(voiSync.id));

        setReady(true);
        onVolumeReady?.({ shellMs: loadMs, loadedMs: performance.now() - started });
        engine.renderingEngine.renderViewports(panes.map((p) => p.id));
        panes.forEach((p) => refresh(p.id));
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
      const engine = engineRef.current;
      if (engine) {
        for (const pane of panes) {
          removeViewportFromGroups(engine, pane.id);
          try {
            engine.renderingEngine.disableElement(pane.id);
          } catch {
            /* gone */
          }
        }
      }
    };
    // Re-mount only when the volume(s) or the pane set change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctVolumeId, ptVolumeId, mode]);

  // Slab: blend mode + thickness on the (non-MIP) planes.
  useEffect(() => {
    const engine = engineRef.current;
    if (!ready || !engine) return;
    const B = engine.core.Enums.BlendModes;
    const blendMode = {
      composite: B.COMPOSITE,
      mip: B.MAXIMUM_INTENSITY_BLEND,
      minip: B.MINIMUM_INTENSITY_BLEND,
      avg: B.AVERAGE_INTENSITY_BLEND,
    }[blend];
    for (const id of orthoIds) {
      const v = vp(id);
      if (!v) continue;
      try {
        v.setBlendMode(blendMode, [ctVolumeId]);
        v.setSlabThickness(blend === "composite" ? Math.max(0.1, slab) : Math.max(1, slab || 10));
        v.render();
      } catch {
        /* viewport not ready */
      }
    }
  }, [ready, blend, slab, orthoIds, vp, ctVolumeId]);

  // 3D preset.
  useEffect(() => {
    if (!ready) return;
    const v = vp("vol-3d");
    if (!v) return;
    try {
      v.setProperties({ preset: vrPreset });
      v.render();
    } catch {
      /* preset not applicable */
    }
  }, [ready, vrPreset, vp]);

  // Fusion overlay look.
  useEffect(() => {
    if (!ready || !ptVolumeId) return;
    for (const id of orthoIds) {
      const v = vp(id);
      if (!v) continue;
      try {
        const ptWindow = suvState === "suv" || maxTouched ? { voiRange: { lower: 0, upper: suvMax } } : {};
        // Background (below ~0.5 SUV) is transparent so the CT reads untinted;
        // uptake ramps to the chosen opacity by 1.5 SUV.
        const ramp =
          suvState === "suv"
            ? [
                { value: 0, opacity: 0 },
                { value: 0.5, opacity: 0 },
                { value: 1.5, opacity },
                // vtk.js samples this function into a fixed table across its
                // own range: a far endpoint (1e6) would put every real SUV in
                // the first bin. 100 SUV keeps ~0.1 SUV resolution.
                { value: 100, opacity },
              ]
            : opacity;
        v.setProperties({ colormap: { name: colormap, opacity: ramp }, ...ptWindow }, ptVolumeId);
        v.render();
      } catch {
        /* overlay actor not ready */
      }
    }
    const mip = vp("vol-petmip");
    if (mip) {
      try {
        const B = engineRef.current!.core.Enums.BlendModes;
        mip.setBlendMode(B.MAXIMUM_INTENSITY_BLEND);
        const span = (petSeries?.imageIds.length ?? 100) * 4;
        mip.setSlabThickness(span);
        mip.setProperties({ ...(suvState === "suv" || maxTouched ? { voiRange: { lower: 0, upper: suvMax } } : {}), invert: true }, ptVolumeId);
        mip.render();
      } catch {
        /* not ready */
      }
    }
  }, [ready, colormap, opacity, suvMax, suvState, maxTouched, ptVolumeId, orthoIds, vp, petSeries]);

  // Left tool for the planes.
  useEffect(() => {
    const engine = engineRef.current;
    if (!ready || !engine) return;
    setGroupLeftTool(engine, MPR_GROUP, leftTool);
  }, [ready, leftTool]);

  const applyPreset = (ww: number, wc: number) => {
    for (const id of orthoIds) vp(id)?.setProperties({ voiRange: voiRangeOf(ww, wc) }, ctVolumeId);
    engineRef.current?.renderingEngine.renderViewports(orthoIds);
  };

  const reset = () => {
    const engine = engineRef.current;
    if (!engine) return;
    for (const pane of panes) {
      const v = vp(pane.id);
      try {
        v?.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true, resetRotation: true });
      } catch {
        /* */
      }
    }
    try {
      const crosshairs = engine.tools.ToolGroupManager.getToolGroup(MPR_GROUP)?.getToolInstance("Crosshairs") as
        | { resetCrosshairs?: () => void }
        | undefined;
      crosshairs?.resetCrosshairs?.();
    } catch {
      /* */
    }
    setBlend("composite");
    setSlab(0);
    engine.renderingEngine.renderViewports(panes.map((p) => p.id));
  };

  const grid = panes.length === 1 ? "grid-cols-1 grid-rows-1" : "grid-cols-2 grid-rows-2";
  const toolButtons = [
    { tool: "Crosshairs", label: "Crosshairs (3D cursor)", icon: <Crosshair /> },
    { tool: "WindowLevel", label: "Window / level", icon: <SunMedium /> },
    { tool: "Pan", label: "Pan", icon: <Hand /> },
    { tool: "Zoom", label: "Zoom", icon: <ZoomIn /> },
    { tool: "Length", label: "Length", icon: <Ruler /> },
    { tool: "EllipticalROI", label: "Ellipse ROI", icon: <Circle /> },
    { tool: "Probe", label: "Probe", icon: <Pipette /> },
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div role="toolbar" aria-label={`${mode} controls`} className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-subtle bg-surface px-2 text-xs">
        <Button size="sm" variant="ghost" onClick={onExit} leadingIcon={<ArrowLeft className="h-4 w-4" />}>
          Images
        </Button>
        <span className="whitespace-nowrap font-semibold uppercase tracking-wide text-accent-bright">
          {mode === "mpr" ? "MPR" : mode === "3d" ? "3D" : "PET / CT fusion"}
        </span>
        {mode !== "3d" && (
          <>
            <span aria-hidden className="h-5 w-px bg-subtle" />
            {toolButtons.map((t) => (
              <IconButton
                key={t.tool}
                aria-label={t.label}
                title={t.label}
                size="sm"
                aria-pressed={leftTool === t.tool}
                onClick={() => setLeftTool(t.tool)}
                className={cn("h-7 w-7 rounded-md", leftTool === t.tool && "bg-accent text-accent-foreground hover:bg-accent")}
              >
                {t.icon}
              </IconButton>
            ))}
            <span aria-hidden className="h-5 w-px bg-subtle" />
            <label className="flex items-center gap-1.5 text-secondary">
              Slab
              <select
                value={blend}
                onChange={(e) => setBlend(e.target.value as Blend)}
                className="h-7 rounded-md border border-subtle bg-elevated px-1 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <option value="composite">Thin</option>
                <option value="mip">MIP</option>
                <option value="minip">MinIP</option>
                <option value="avg">Average</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-secondary">
              <input
                type="range"
                min={0}
                max={60}
                step={1}
                value={slab}
                onChange={(e) => setSlab(Number(e.target.value))}
                disabled={blend === "composite"}
                aria-label="Slab thickness in millimetres"
                className="w-24 accent-[rgb(var(--accent))] disabled:opacity-40"
              />
              <span className="w-12 tabular-nums text-primary">{blend === "composite" ? "—" : `${slab || 10} mm`}</span>
            </label>
            {presets.length > 0 && (
              <select
                aria-label="Window preset"
                defaultValue=""
                onChange={(e) => {
                  const p = presets.find((x) => x.id === e.target.value);
                  if (p) applyPreset(p.ww, p.wc);
                  e.target.value = "";
                }}
                className="h-7 rounded-md border border-subtle bg-elevated px-1 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <option value="" disabled>
                  Window…
                </option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        {panes.some((p) => p.kind === "3d") && (
          <label className="flex items-center gap-1.5 text-secondary">
            3D preset
            <select
              value={vrPreset}
              onChange={(e) => setVrPreset(e.target.value)}
              className="h-7 rounded-md border border-subtle bg-elevated px-1 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {VR_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p.replace(/-/g, " ")}
                </option>
              ))}
            </select>
          </label>
        )}
        {mode === "fusion" && (
          <>
            <label className="flex items-center gap-1.5 text-secondary">
              PET
              <select
                value={colormap}
                onChange={(e) => setColormap(e.target.value)}
                className="h-7 rounded-md border border-subtle bg-elevated px-1 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {PET_COLORMAPS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-secondary">
              Opacity
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
                className="w-20 accent-[rgb(var(--accent))]"
              />
            </label>
            <label className="flex items-center gap-1.5 text-secondary">
              {suvState === "suv" ? "SUV max" : "Max"}
              <input
                type="range"
                min={1}
                max={suvState === "suv" ? 20 : 30000}
                step={suvState === "suv" ? 0.5 : 100}
                value={suvMax}
                onChange={(e) => {
                  setMaxTouched(true);
                  setSuvMax(Number(e.target.value));
                }}
                className="w-20 accent-[rgb(var(--accent))]"
              />
              <span className="w-10 tabular-nums text-primary">{suvMax}</span>
            </label>
          </>
        )}
        <IconButton aria-label="Reset" title="Reset planes" size="sm" className="ml-auto h-7 w-7 rounded-md" onClick={reset}>
          <RotateCcw />
        </IconButton>
      </div>

      <div className={cn("relative grid min-h-0 flex-1 gap-px bg-black", grid)}>
        {panes.map((pane) => {
          const r = readouts[pane.id];
          return (
            <div key={pane.id} className="relative overflow-hidden bg-imaging" onContextMenu={(e) => e.preventDefault()}>
              <div
                ref={(el) => {
                  elements.current[pane.id] = el;
                }}
                className="cs-viewport absolute inset-0"
                data-viewport-id={pane.id}
              />
              {showOverlay && (
                <div className="pointer-events-none absolute inset-0 p-2 text-[11px] leading-[1.35] text-white/90 text-halo tabular-nums">
                  <div className="absolute left-2 top-2">
                    <div className="font-semibold text-white">{pane.label}</div>
                    <div>{formatPersonName(study?.patient.name)}</div>
                  </div>
                  <div className="absolute right-2 top-2 max-w-[45%] truncate text-right">
                    {pane.petMip ? petSeries?.description : series.description}
                  </div>
                  {pane.kind === "ortho" && (
                    <div className="absolute bottom-2 left-2">
                      {pane.petMip
                        ? suvState === "suv"
                          ? `SUVbw 0–${suvMax}`
                          : `0–${suvMax} (raw)`
                        : r?.ww != null
                          ? `W ${Math.round(r.ww)} · L ${Math.round(r.wc ?? 0)}`
                          : ""}
                      {mode === "fusion" && !pane.petMip && (
                        <div>
                          PET {suvState === "suv" ? `SUVbw 0–${suvMax}` : `raw 0–${suvMax}`} · {Math.round(opacity * 100)}%
                        </div>
                      )}
                      {blend !== "composite" && !pane.petMip && (
                        <div className="text-accent-bright">
                          {blend.toUpperCase()} {slab || 10} mm
                        </div>
                      )}
                    </div>
                  )}
                  {pane.kind === "3d" && (
                    <div className="absolute bottom-2 left-2">
                      {vrPreset.replace(/-/g, " ")} · drag to rotate
                    </div>
                  )}
                  {r?.edges && pane.kind === "ortho" && (
                    <>
                      <span className="absolute left-1/2 top-2 -translate-x-1/2 font-semibold text-warning/90">{r.edges.top}</span>
                      <span className="absolute bottom-2 left-1/2 -translate-x-1/2 font-semibold text-warning/90">{r.edges.bottom}</span>
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 font-semibold text-warning/90">{r.edges.left}</span>
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 font-semibold text-warning/90">{r.edges.right}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!ready && !error && (
          <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/75 px-3 py-1 text-xs text-white tabular-nums">
            <Spinner size="sm" label="Building volume" />
            {`Building volume ${Math.round(progress * 100)}%`}
          </div>
        )}
        {error && (
          <div role="alert" className="absolute inset-x-8 top-1/2 -translate-y-1/2 rounded-xl bg-black/85 p-4 text-center text-sm text-danger">
            The volume could not be built: {error}
            <div className="mt-3">
              <Button size="sm" variant="secondary" onClick={onExit}>
                Back to images
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
