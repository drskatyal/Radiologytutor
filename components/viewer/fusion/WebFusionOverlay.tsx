"use client";

// PET / CT fusion on the free web viewer, as on FlowRad Viewer (desktop
// VolumeWorkspace "fusion"): the CT with a colour PET overlay in axial,
// coronal and sagittal, linked by crosshairs, plus a coronal PET MIP. PET is
// in SUVbw when the dose, timing and weight tags allow (lib/webPetSuv.ts),
// raw units otherwise, and the panel says which.
//
// Both volumes stream in from the images the viewer already holds (local
// files never leave the browser) and are released on exit. Loaded on first
// use: CornerstoneViewer → LocalStudyViewer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Crosshair, SunMedium } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Slider } from "@/components/ui/Slider";
import { cn } from "@/components/ui/cn";
import { PET_COLORMAPS, PET_COLORMAP_LABELS, petOpacityRamp, suvFactorToApply, type LoaderPreScale } from "@flowrad/viewer-core/petFusion";
import { wwWcToVoi } from "@flowrad/viewer-core/viewportVoi";
import { ensureWebSuv, type SuvState } from "@/lib/webPetSuv";

const ENGINE_ID = "web-fusion-engine";
const FUSED_GROUP = "web-fusion-fused";
const MIP_GROUP = "web-fusion-mip";

interface Pane {
  id: string;
  label: string;
  orientation: "AXIAL" | "CORONAL" | "SAGITTAL";
  mip?: boolean;
}

const PANES: Pane[] = [
  { id: "web-fusion-axial", label: "Axial · fused", orientation: "AXIAL" },
  { id: "web-fusion-coronal", label: "Coronal · fused", orientation: "CORONAL" },
  { id: "web-fusion-sagittal", label: "Sagittal · fused", orientation: "SAGITTAL" },
  { id: "web-fusion-mip", label: "PET MIP", orientation: "CORONAL", mip: true },
];
const FUSED = PANES.filter((p) => !p.mip).map((p) => p.id);


const SELECT =
  "h-8 rounded-lg border border-strong bg-elevated px-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

interface Props {
  ctImageIds: readonly string[];
  ptImageIds: readonly string[];
  ctLabel: string;
  ptLabel: string;
  onExit: () => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Cornerstone's volume viewport API, loaded at runtime */
type Core = any;

export function WebFusionOverlay({ ctImageIds, ptImageIds, ctLabel, ptLabel, onExit }: Props) {
  const elements = useRef<Record<string, HTMLDivElement | null>>({});
  const coreRef = useRef<Core | null>(null);
  const ids = useMemo(() => {
    const stamp = Date.now().toString(36);
    return { ct: `web-fusion-ct:${stamp}`, pt: `web-fusion-pt:${stamp}` };
  }, []);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [suv, setSuv] = useState<SuvState | null>(null);
  const [peak, setPeak] = useState<number | null>(null);
  const [colormap, setColormap] = useState<string>("hsv");
  const [opacity, setOpacity] = useState(0.6);
  const [max, setMax] = useState(6);
  /** Volume units per displayed unit: 1, or 1/suvbw when the PET volume stays in raw counts. */
  const [rawPerSuv, setRawPerSuv] = useState<number | null>(null);
  const [leftTool, setLeftTool] = useState<"Crosshairs" | "WindowLevel">("Crosshairs");

  const viewport = useCallback((id: string) => {
    try {
      return coreRef.current?.getRenderingEngine(ENGINE_ID)?.getViewport(id) ?? null;
    } catch {
      return null;
    }
  }, []);

  // Build: SUV factors first (they change how PET pixels decode), then both volumes.
  useEffect(() => {
    let disposed = false;
    let offProgress: (() => void) | null = null;
    void (async () => {
      try {
        const [core, tools] = await Promise.all([import("@cornerstonejs/core"), import("@cornerstonejs/tools")]);
        coreRef.current = core;
        const state = await ensureWebSuv(ptImageIds);
        if (disposed) return;
        setSuv(state);
        try {
          core.getRenderingEngine(ENGINE_ID)?.destroy();
        } catch {
          /* none */
        }
        const engine = new core.RenderingEngine(ENGINE_ID);
        engine.setViewports(
          PANES.map((p) => ({
            viewportId: p.id,
            type: core.Enums.ViewportType.ORTHOGRAPHIC,
            element: elements.current[p.id]!,
            defaultOptions: { orientation: core.Enums.OrientationAxis[p.orientation], background: [0, 0, 0] as [number, number, number] },
          }))
        );
        // The local loader reads a slice's header when the slice first loads,
        // and a volume needs every slice's geometry up front: load what the
        // stack has not yet (PET now decodes in SUV, the factors exist).
        const all = [...ctImageIds, ...ptImageIds];
        const missing = all.filter((id) => {
          try {
            return !core.metaData.get("imagePlaneModule", id) || !core.metaData.get("imagePixelModule", id);
          } catch {
            return true;
          }
        });
        let warmed = 0;
        let cursor = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, missing.length) }, async () => {
            while (cursor < missing.length && !disposed) {
              const id = missing[cursor++]!;
              try {
                await core.imageLoader.loadAndCacheImage(id, { priority: -5, requestType: "prefetch" } as never);
              } catch {
                /* the volume reports a slice it still cannot place */
              }
              warmed += 1;
              setProgress((0.5 * warmed) / missing.length);
            }
          })
        );
        if (disposed) return;
        // A bare image load ignores the SUV factors; the volume loader applies
        // them. Drop the warmed PET pixels (headers stay) so the volume decodes
        // them itself, in SUV.
        if (state === "suv") {
          for (const id of ptImageIds) {
            try {
              core.cache.removeImageLoadObject(id, { force: true }); // throws when not cached
            } catch {
              /* already gone */
            }
          }
        }
        const total = ctImageIds.length + ptImageIds.length;
        const done = { [ids.ct]: 0, [ids.pt]: 0 } as Record<string, number>;
        const onModified = (evt: Event) => {
          const d = (evt as CustomEvent<{ volumeId?: string; framesProcessed?: number }>).detail;
          if (!d?.volumeId || !(d.volumeId in done)) return;
          done[d.volumeId] = d.framesProcessed ?? done[d.volumeId]!;
          setProgress((missing.length ? 0.5 : 0) + ((missing.length ? 0.5 : 1) * (done[ids.ct]! + done[ids.pt]!)) / Math.max(1, total));
        };
        core.eventTarget.addEventListener(core.Enums.Events.IMAGE_VOLUME_MODIFIED, onModified);
        offProgress = () => core.eventTarget.removeEventListener(core.Enums.Events.IMAGE_VOLUME_MODIFIED, onModified);

        const ct = await core.volumeLoader.createAndCacheVolume(ids.ct, { imageIds: [...ctImageIds] });
        const pt = await core.volumeLoader.createAndCacheVolume(ids.pt, { imageIds: [...ptImageIds] });
        if (disposed) return;
        // load() calls back once per frame: done when the volume says so.
        const loaded = (v: { load: (cb: () => void) => void; loadStatus?: { loaded?: boolean } }) =>
          new Promise<void>((resolve) => v.load(() => v.loadStatus?.loaded && resolve()));
        const both = Promise.all([loaded(ct), loaded(pt)]);
        await core.setVolumesForViewports(engine, [{ volumeId: ids.ct }, { volumeId: ids.pt }], FUSED);
        await core.setVolumesForViewports(engine, [{ volumeId: ids.pt }], ["web-fusion-mip"]);
        for (const id of FUSED) {
          const v = engine.getViewport(id) as Core;
          v.setProperties({ voiRange: wwWcToVoi(400, 40) }, ids.ct);
        }

        for (const Tool of [tools.CrosshairsTool, tools.WindowLevelTool, tools.PanTool, tools.ZoomTool, tools.StackScrollTool]) {
          try {
            tools.addTool(Tool);
          } catch {
            /* registered by the stack viewer */
          }
        }
        const { MouseBindings } = tools.Enums;
        for (const name of [FUSED_GROUP, MIP_GROUP]) {
          try {
            tools.ToolGroupManager.destroyToolGroup(name);
          } catch {
            /* none */
          }
        }
        const fused = tools.ToolGroupManager.createToolGroup(FUSED_GROUP)!;
        fused.addTool(tools.CrosshairsTool.toolName, {
          getReferenceLineControllable: () => true,
          getReferenceLineDraggableRotatable: () => true,
          getReferenceLineSlabThicknessControlsOn: () => false,
        });
        for (const Tool of [tools.WindowLevelTool, tools.PanTool, tools.ZoomTool, tools.StackScrollTool]) fused.addTool(Tool.toolName);
        for (const id of FUSED) fused.addViewport(id, ENGINE_ID);
        fused.setToolActive(tools.StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });
        fused.setToolActive(tools.PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
        fused.setToolActive(tools.ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
        fused.setToolActive(tools.CrosshairsTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
        const mip = tools.ToolGroupManager.createToolGroup(MIP_GROUP)!;
        for (const Tool of [tools.PanTool, tools.ZoomTool]) mip.addTool(Tool.toolName);
        mip.addViewport("web-fusion-mip", ENGINE_ID);
        mip.setToolActive(tools.PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }, { mouseButton: MouseBindings.Auxiliary }] });
        mip.setToolActive(tools.ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });

        engine.render();
        setPhase("ready");
        await both;
        if (disposed) return;
        // Did the loader actually apply SUV? Not when the volume stays in raw
        // counts (no float textures), nor for a PET with slope 1 and intercept
        // 0 (the image loader then skips pre-scaling, SUV included). Either
        // way the factor sits beside the volume, and the window, ramp and
        // readout convert through it.
        const mid = ptImageIds[Math.floor(ptImageIds.length / 2)]!;
        const factor =
          state === "suv"
            ? suvFactorToApply(
                (core.cache.getImage(mid) as { preScale?: LoaderPreScale } | undefined)?.preScale,
                (pt as { isPreScaled?: boolean }).isPreScaled,
                (pt as { scaling?: { PT?: { suvbw?: number } } }).scaling?.PT?.suvbw
              )
            : null;
        setRawPerSuv(factor ? 1 / factor : 1);
        setProgress(1);
        try {
          // The voxels themselves: getRange() can report the pre-SUV range.
          const data = (pt as Core).voxelManager.getCompleteScalarDataArray() as ArrayLike<number>;
          let raw = -Infinity;
          for (let i = 0; i < data.length; i += 1) if (data[i]! > raw) raw = data[i]!;
          const hi = factor ? raw * factor : raw;
          if (Number.isFinite(hi)) {
            setPeak(hi);
            // Raw counts have no fixed scale: start the overlay at 60% of the peak.
            if (state === "raw") setMax(Math.max(1, Math.round(hi * 0.6)));
          }
        } catch {
          /* range unavailable: the readout stays empty */
        }
        engine.render();
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      }
    })();
    return () => {
      disposed = true;
      offProgress?.();
      void (async () => {
        const [core, tools] = await Promise.all([import("@cornerstonejs/core"), import("@cornerstonejs/tools")]);
        for (const name of [FUSED_GROUP, MIP_GROUP]) {
          try {
            tools.ToolGroupManager.destroyToolGroup(name);
          } catch {
            /* gone */
          }
        }
        try {
          core.getRenderingEngine(ENGINE_ID)?.destroy();
        } catch {
          /* gone */
        }
        for (const id of [ids.ct, ids.pt]) {
          try {
            (core.cache.getVolume(id) as { cancelLoading?: () => void } | undefined)?.cancelLoading?.();
            if (core.cache.getVolumeLoadObject(id)) core.cache.removeVolumeLoadObject(id);
          } catch {
            /* not cached */
          }
        }
      })();
    };
  }, [ctImageIds, ptImageIds, ids]);

  // Overlay look: colour map, opacity ramp, PET window 0…max; MIP inverted grey.
  useEffect(() => {
    if (phase !== "ready" || !suv || rawPerSuv == null) return;
    const upper = max * rawPerSuv;
    for (const id of FUSED) {
      const v = viewport(id) as Core;
      if (!v) continue;
      try {
        v.setProperties({ colormap: { name: colormap, opacity: petOpacityRamp(opacity, suv === "suv", rawPerSuv) }, voiRange: { lower: 0, upper } }, ids.pt);
        v.render();
      } catch {
        /* overlay actor not ready */
      }
    }
    const mip = viewport("web-fusion-mip") as Core;
    if (mip) {
      try {
        const B = coreRef.current.Enums.BlendModes;
        mip.setBlendMode(B.MAXIMUM_INTENSITY_BLEND);
        mip.setSlabThickness(Math.max(500, ptImageIds.length * 10));
        mip.setProperties({ voiRange: { lower: 0, upper }, invert: true }, ids.pt);
        mip.render();
      } catch {
        /* not ready */
      }
    }
  }, [phase, suv, rawPerSuv, colormap, opacity, max, viewport, ids.pt, ptImageIds.length]);

  // Left button: crosshairs (linked planes) or CT window.
  useEffect(() => {
    if (phase !== "ready") return;
    void import("@cornerstonejs/tools").then((tools) => {
      const group = tools.ToolGroupManager.getToolGroup(FUSED_GROUP);
      if (!group) return;
      const primary = { mouseButton: tools.Enums.MouseBindings.Primary };
      const other = leftTool === "Crosshairs" ? tools.WindowLevelTool.toolName : tools.CrosshairsTool.toolName;
      group.setToolPassive(other, { removeAllBindings: [primary] });
      group.setToolActive(leftTool === "Crosshairs" ? tools.CrosshairsTool.toolName : tools.WindowLevelTool.toolName, { bindings: [primary] });
    });
  }, [phase, leftTool]);

  // Keep the canvases sized to their panes.
  useEffect(() => {
    if (phase !== "ready") return;
    const observer = new ResizeObserver(() => {
      try {
        coreRef.current?.getRenderingEngine(ENGINE_ID)?.resize(true, false);
      } catch {
        /* destroyed */
      }
    });
    for (const el of Object.values(elements.current)) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [phase]);

  const unit = suv === "suv" ? "SUVbw" : "raw";
  const maxRange = suv === "suv" ? { min: 1, max: 20, step: 0.5 } : { min: 1, max: Math.max(100, Math.ceil((peak ?? 30000) * 1.2)), step: 1 };
  const fmt = (n: number) => (suv === "suv" ? n.toFixed(1) : Math.round(n).toLocaleString());

  return (
    <div
      // The reading room's dark surface and brand green (.modal-reading tokens).
      className="modal-reading absolute inset-0 z-30 flex flex-col bg-canvas text-primary"
      data-testid="fusion-workspace"
      data-suv={suv ?? undefined}
      data-peak={peak != null ? peak.toFixed(2) : undefined}
      data-loaded={progress >= 1 && peak != null ? "true" : undefined}
      // The workspace owns its keys and pointer: the stack viewer underneath must not react.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onExit();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-subtle bg-surface px-3 py-2">
        <Button size="sm" variant="secondary" onClick={onExit} leadingIcon={<ArrowLeft className="h-4 w-4" />}>
          Back to images
        </Button>
        <h2 className="text-sm font-semibold">PET / CT fusion</h2>
        <div role="radiogroup" aria-label="Left button" className="flex overflow-hidden rounded-lg border border-strong">
          {(
            [
              ["Crosshairs", "Crosshairs", Crosshair],
              ["WindowLevel", "CT window", SunMedium],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={leftTool === id}
              onClick={() => setLeftTool(id)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                leftTool === id ? "bg-accent/15 text-primary" : "text-secondary hover:bg-elevated"
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-secondary">
          Colour
          <select value={colormap} onChange={(e) => setColormap(e.target.value)} className={SELECT}>
            {PET_COLORMAPS.map((c) => (
              <option key={c} value={c}>
                {PET_COLORMAP_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <Slider
          className="w-40 py-0"
          label="PET opacity"
          min={0}
          max={1}
          step={0.05}
          value={opacity}
          valueLabel={`${Math.round(opacity * 100)}%`}
          onChange={setOpacity}
        />
        <Slider
          className="w-44 py-0"
          label={suv === "suv" ? "SUV max" : "PET max (raw)"}
          {...maxRange}
          value={max}
          valueLabel={fmt(max)}
          onChange={setMax}
        />
        <p className="ml-auto text-xs text-secondary tabular-nums" data-testid="fusion-units">
          {suv == null ? "Reading PET tags…" : suv === "suv" ? "PET in SUVbw (body weight)" : "PET in raw units: dose, time or weight tags missing"}
          {peak != null && (
            <>
              {" · "}
              <span className="text-primary">
                Peak {unit} {fmt(peak)}
              </span>
            </>
          )}
        </p>
      </div>

      <div className="relative grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-px bg-[#1F1F1F]">
        {PANES.map((pane) => (
          <div key={pane.id} className="relative min-h-0 overflow-hidden bg-imaging">
            <div
              ref={(el) => {
                elements.current[pane.id] = el;
              }}
              className="absolute inset-0"
              role="img"
              aria-label={`${pane.label}: ${pane.mip ? ptLabel : `${ctLabel} with ${ptLabel}`}`}
            />
            <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-0.5 text-xs text-white/85 [text-shadow:0_1px_2px_#000]">
              <span className="font-medium">{pane.label}</span>
              <span className="text-white/60">{pane.mip ? ptLabel : ctLabel}</span>
            </div>
            <span className="pointer-events-none absolute bottom-2 left-2 text-[11px] text-white/70 tabular-nums [text-shadow:0_1px_2px_#000]">
              {pane.mip ? `${unit} 0–${fmt(max)}` : `PET ${unit} 0–${fmt(max)} · ${Math.round(opacity * 100)}%`}
            </span>
          </div>
        ))}
        {(phase !== "ready" || rawPerSuv == null) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-imaging p-6 text-center text-sm text-white/80">
            {phase === "error" ? (
              <p role="alert" className="max-w-md text-danger">
                Fusion could not start: {error}
              </p>
            ) : (
              <>
                <p className="tabular-nums">Building the CT and PET volumes in this browser… {Math.round(progress * 100)}%</p>
                <ProgressBar value={suv == null ? null : progress} label="Building the fusion volumes" className="w-56" />
              </>
            )}
          </div>
        )}
        {phase === "ready" && rawPerSuv != null && progress < 1 && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0">
            <ProgressBar value={progress} label="Loading slices" className="h-1 rounded-none" />
          </div>
        )}
      </div>
    </div>
  );
}
