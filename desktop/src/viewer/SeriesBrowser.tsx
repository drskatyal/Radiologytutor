// Series browser: studies → series cards with decoded thumbnails.
//
// Thumbnails decode the middle image at thumbnail priority, one at a time, so
// they never compete with the image the reader is looking at. Drag a card onto
// any viewport, click to load it in the active one.

import { memo, useEffect, useRef, useState } from "react";
import { Layers, Film, Box } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Badge } from "@/components/ui/Badge";
import type { ViewerSeries, ViewerStudy } from "../types";
import { describeSeries, formatDicomDate, formatPersonName } from "../study";
import { getEngine } from "./engine";
import { ensureSuv } from "./suv";

const THUMB = 112;

// One queue for the whole window, newest request last.
let queue: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task, task);
}

const thumbCache = new Map<string, string>();

function Thumbnail({ series }: { series: ViewerSeries }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const middle = series.imageIds[Math.floor(series.imageIds.length / 2)];
  const [state, setState] = useState<"loading" | "ready" | "error">(
    middle && thumbCache.has(middle) ? "ready" : "loading"
  );
  const [src, setSrc] = useState<string | null>(middle ? thumbCache.get(middle) ?? null : null);

  useEffect(() => {
    if (!middle || thumbCache.has(middle)) return;
    let cancelled = false;
    enqueue(async () => {
      if (cancelled || !canvasRef.current) return;
      try {
        const { core } = await getEngine();
        // PET: register SUV scaling BEFORE the first decode. The cache is
        // shared, and an unscaled thumbnail slice would later sit in the
        // fused volume as one raw-count plane.
        await ensureSuv(series);
        const canvas = canvasRef.current;
        if (!canvas) return;
        await core.utilities.loadImageToCanvas({
          canvas,
          imageId: middle,
          thumbnail: true,
          requestType: core.Enums.RequestType.Thumbnail,
          priority: 5,
        } as Parameters<typeof core.utilities.loadImageToCanvas>[0]);
        const url = canvas.toDataURL("image/jpeg", 0.8);
        thumbCache.set(middle, url);
        if (!cancelled) {
          setSrc(url);
          setState("ready");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [middle]);

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-md bg-imaging">
      {src ? (
        <img src={src} alt="" className="h-full w-full object-contain" draggable={false} />
      ) : (
        <canvas ref={canvasRef} width={THUMB} height={THUMB} className="h-full w-full object-contain" />
      )}
      {state === "loading" && !src && (
        <div className="absolute inset-0 animate-pulse bg-gradient-to-b from-white/[0.03] to-white/[0.07]" />
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex items-center justify-center px-2 text-center text-[10px] text-muted">
          No preview
        </div>
      )}
    </div>
  );
}

interface Props {
  studies: ViewerStudy[];
  /** Series UIDs on screen, by cell index, for the "in viewport" marker. */
  onScreen: (string | null)[];
  activeSeriesUid: string | null;
  growing: boolean;
  /** Dense one-line rows instead of thumbnails. */
  compact?: boolean;
  hidePatient?: boolean;
  onOpenSeries: (uid: string) => void;
}

function SeriesBrowserImpl({ studies, onScreen, activeSeriesUid, growing, compact = false, hidePatient = false, onOpenSeries }: Props) {
  return (
    <nav aria-label="Series" className="flex h-full flex-col overflow-y-auto overscroll-contain p-2">
      {studies.map((study) => (
        <section key={study.uid} className="mb-3">
          <header className="sticky top-0 z-10 -mx-2 mb-2 border-b border-subtle bg-surface/95 px-3 py-2 backdrop-blur">
            <div className="truncate text-xs font-semibold text-primary" title={hidePatient ? undefined : formatPersonName(study.patient.name)}>
              {hidePatient ? "Patient hidden" : formatPersonName(study.patient.name) || "Unnamed patient"}
            </div>
            <div className="truncate text-[11px] text-secondary" title={study.description}>
              {study.description || "Study"}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted tabular-nums">
              <span>{formatDicomDate(study.date) || "No date"}</span>
              <span aria-hidden>·</span>
              <span>{study.modalities.join(" / ")}</span>
              <span aria-hidden>·</span>
              <span>{study.imageCount.toLocaleString()} im</span>
            </div>
          </header>
          <ul className={compact ? "flex flex-col gap-0.5" : "grid grid-cols-2 gap-2"}>
            {study.series.map((series) => {
              const cells = onScreen.flatMap((uid, i) => (uid === series.uid ? [i + 1] : []));
              const isActive = series.uid === activeSeriesUid;
              const drag = (e: React.DragEvent) => {
                e.dataTransfer.setData("application/x-radlearn-series", series.uid);
                e.dataTransfer.effectAllowed = "copy";
              };
              if (compact)
                return (
                  <li key={series.uid}>
                    <button
                      type="button"
                      draggable
                      onDragStart={drag}
                      onClick={() => onOpenSeries(series.uid)}
                      title={`${describeSeries(series)} — click to show, or drag onto a viewport`}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                        isActive ? "bg-accent-muted/40 text-primary" : "text-secondary hover:bg-elevated hover:text-primary"
                      )}
                    >
                      <span className="w-12 shrink-0 font-semibold tabular-nums text-primary">
                        {series.modality}
                        {series.number != null ? ` ${series.number}` : ""}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{describeSeries(series)}</span>
                      {cells.length > 0 && (
                        <span className="rounded bg-accent px-1 text-[10px] font-semibold text-accent-foreground tabular-nums">{cells.join(",")}</span>
                      )}
                      <span className="shrink-0 text-muted tabular-nums">{series.imageCount}</span>
                    </button>
                  </li>
                );
              return (
                <li key={series.uid}>
                  <button
                    type="button"
                    draggable
                    onDragStart={drag}
                    onClick={() => onOpenSeries(series.uid)}
                    title={`${describeSeries(series)} — click to show, or drag onto a viewport`}
                    className={cn(
                      "group flex w-full flex-col gap-1 rounded-lg border p-1 text-left transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      isActive
                        ? "border-accent bg-accent-muted/40"
                        : cells.length > 0
                          ? "border-strong bg-elevated"
                          : "border-transparent hover:border-strong hover:bg-elevated"
                    )}
                  >
                    <div className="relative">
                      <Thumbnail series={series} />
                      <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-semibold text-white tabular-nums">
                        {series.modality}
                        {series.number != null ? ` ${series.number}` : ""}
                      </span>
                      {cells.length > 0 && (
                        <span className="absolute right-1 top-1 rounded bg-accent px-1 text-[10px] font-semibold text-accent-foreground tabular-nums">
                          {cells.join(",")}
                        </span>
                      )}
                      <span className="absolute bottom-1 right-1 flex items-center gap-0.5 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums">
                        {series.multiframe ? (
                          <Film className="h-3 w-3" aria-hidden />
                        ) : series.volumetric ? (
                          <Box className="h-3 w-3" aria-hidden />
                        ) : (
                          <Layers className="h-3 w-3" aria-hidden />
                        )}
                        {series.imageCount}
                      </span>
                    </div>
                    <span className="line-clamp-2 min-h-[2lh] px-0.5 text-[11px] leading-tight text-secondary group-hover:text-primary">
                      {describeSeries(series)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {growing && (
        <div className="px-1 pb-2">
          <Badge variant="neutral">Still reading files…</Badge>
        </div>
      )}
    </nav>
  );
}

export const SeriesBrowser = memo(SeriesBrowserImpl);
