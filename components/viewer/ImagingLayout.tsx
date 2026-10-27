"use client";

// Imaging stage chrome shared by Studio record, the student reading room,
// and click-the-finding exams.
//
// The series rail is a vertical PACS list (description, modality, count).
// Fullscreen lifts just this stage — image plus rail — over the app chrome.
// Escape or Exit puts the chrome back. In fullscreen the rail floats on the
// left so the pixels can fill the screen, and it can collapse.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button, IconButton } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { CaseSeries } from "@/lib/viewerSource";
import type { RailInstanceSource } from "@/lib/seriesRail";
import { SeriesNavigator } from "./SeriesNavigator";
import { useLazySeriesRail } from "./useLazySeriesRail";

export function ImagingLayout({
  series = [],
  activeIndex = 0,
  onSelectSeries,
  seriesLoading = false,
  mainImageReady,
  listedSeries,
  pane = "dock",
  fill = false,
  className,
  children,
}: {
  series?: CaseSeries[];
  activeIndex?: number;
  onSelectSeries?: (index: number) => void;
  seriesLoading?: boolean;
  /**
   * True once the main viewport has its first image. Thumbnails and any
   * per-series instance lookup wait for this so they cannot delay first pixels.
   * Omit on a surface that is not a live viewport.
   */
  mainImageReady?: boolean;
  /** Instance lists already in hand (prefetch manifest). Counts, no extra QIDO. */
  listedSeries?: readonly RailInstanceSource[] | null;
  /**
   * `dock` pins the rail beside the image from the md breakpoint up.
   * `overlay` always floats it (narrow exam cards). Fullscreen always floats.
   */
  pane?: "dock" | "overlay";
  /** Stretch to the parent height (student reading room, exam card). */
  fill?: boolean;
  className?: string;
  children: ReactNode | ((expanded: boolean) => ReactNode);
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [native, setNative] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [paneOpen, setPaneOpen] = useState(true);
  const expanded = native || fallback;
  const railSeries = useLazySeriesRail(series, mainImageReady, listedSeries);
  const showPane = seriesLoading || railSeries.length > 1;
  const overlayPane = expanded || pane === "overlay";

  useEffect(() => {
    const onChange = () => {
      const live = document.fullscreenElement === rootRef.current;
      setNative(live);
      if (live) setFallback(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (!fallback) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [fallback]);

  const exit = useCallback(async () => {
    if (document.fullscreenElement === rootRef.current) {
      try {
        await document.exitFullscreen();
      } catch {
        setNative(false);
        setFallback(false);
      }
      return;
    }
    setFallback(false);
    setNative(false);
  }, []);

  const enter = useCallback(async () => {
    const el = rootRef.current;
    if (!el) return;
    const canNative =
      document.fullscreenEnabled && typeof el.requestFullscreen === "function";
    if (canNative) {
      try {
        await el.requestFullscreen();
        return;
      } catch {
        /* iframe or a rejected gesture — cover the viewport in CSS */
      }
    }
    setFallback(true);
  }, []);

  const toggle = useCallback(() => {
    if (expanded) void exit();
    else void enter();
  }, [enter, exit, expanded]);

  useEffect(() => {
    const isText = (el: EventTarget | null) => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && expanded) {
        e.preventDefault();
        e.stopPropagation();
        void exit();
        return;
      }
      if (e.key.toLowerCase() !== "f" || e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isText(e.target)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [expanded, exit, toggle]);

  const body = typeof children === "function" ? children(expanded) : children;

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative flex min-w-0 bg-imaging",
        fill && "h-full w-full",
        !fill && "w-full",
        fallback && "fixed inset-0 z-[70] h-screen w-screen",
        "[&:fullscreen]:h-full [&:fullscreen]:w-full [&:fullscreen]:bg-canvas",
        className
      )}
    >
      {showPane && paneOpen && (
        <div
          className={cn(
            "flex w-60 min-h-0 flex-col overflow-hidden border-r border-subtle bg-surface",
            overlayPane
              ? "absolute inset-y-0 left-0 z-20 max-w-[calc(100%-9rem)] shadow-lg"
              : "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:max-w-[calc(100%-9rem)] max-md:shadow-lg md:relative md:w-60 md:shrink-0"
          )}
        >
          {/* Docked rail: absolute inset matches the image height so a long
              MRI list scrolls instead of stretching the page. */}
          <SeriesNavigator
            series={railSeries}
            activeIndex={activeIndex}
            onSelect={(index) => onSelectSeries?.(index)}
            loading={seriesLoading && series.length === 0}
            className={cn(
              "h-full min-h-0",
              !overlayPane && "md:absolute md:inset-0"
            )}
          />
        </div>
      )}

      <div className={cn("relative min-w-0 flex-1", (fill || expanded) && "h-full min-h-0")}>
        {body}
        <div className="pointer-events-none absolute right-2 top-2 z-40 flex items-center gap-1">
          <div className="pointer-events-auto flex items-center gap-1 rounded-lg bg-black/75 p-1 shadow-lg ring-1 ring-white/20">
            {showPane && (
              <IconButton
                aria-label={
                  paneOpen
                    ? "Hide series list"
                    : `Show series list${series.length ? `, ${series.length} series` : ""}`
                }
                aria-expanded={paneOpen}
                size="sm"
                variant="secondary"
                onClick={() => setPaneOpen((open) => !open)}
              >
                {paneOpen ? (
                  <PanelLeftClose className="h-4 w-4" />
                ) : (
                  <PanelLeftOpen className="h-4 w-4" />
                )}
              </IconButton>
            )}
            <Button
              size="sm"
              variant="secondary"
              aria-pressed={expanded}
              aria-label={expanded ? "Exit fullscreen" : "Fullscreen viewer"}
              leadingIcon={
                expanded ? (
                  <Minimize2 className="h-3.5 w-3.5" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" />
                )
              }
              onClick={toggle}
            >
              {expanded ? "Exit" : "Full screen"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
