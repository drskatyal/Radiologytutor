"use client";

// Imaging stage chrome shared by Studio record, the student reading room,
// and click-the-finding exams.
//
// The series rail is a vertical PACS list (description, modality, count).
// One chevron collapses it to a narrow strip so the viewport can use the
// width, and expands it again. The choice is kept in localStorage for this
// browser. Fullscreen lifts just this stage — image plus rail — over the
// app chrome. Escape or Exit puts the chrome back. In fullscreen the rail
// floats on the left.
//
// Collapsing is presentation only. The Cornerstone viewport stays mounted,
// so Gemini Live set_series / show_finding still switch series while the
// list is closed.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import {
  SERIES_RAIL_NARROW_STORAGE_KEY,
  SERIES_RAIL_STORAGE_KEY,
  SERIES_RAIL_TOGGLE_KEY,
  readSeriesRailOpenForViewport,
  seriesRailToggleLabel,
  writeSeriesRailOpenForViewport,
} from "@/lib/seriesRailPreference";
import { NARROW_LAYOUT_MEDIA, requestStageFullscreen } from "@/lib/viewerLayout";
import type { CaseSeries } from "@/lib/viewerSource";
import type { RailInstanceSource } from "@/lib/seriesRail";
import { SeriesNavigator } from "./SeriesNavigator";
import { useLazySeriesRail } from "./useLazySeriesRail";
import { ImagingStageContext, type ImagingStage } from "./stageContext";

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
  fullscreenDock,
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
  /**
   * Rendered inside the fullscreen stage (native or the CSS cover) so controls
   * such as the live mic stay reachable after the page chrome is covered.
   */
  fullscreenDock?: ReactNode;
  children: ReactNode | ((expanded: boolean) => ReactNode);
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const openBtnRef = useRef<HTMLButtonElement>(null);
  const closedBtnRef = useRef<HTMLButtonElement>(null);
  const focusToggle = useRef(false);
  const paneOpenRef = useRef(true);
  const railId = useId();
  const [native, setNative] = useState(false);
  const [fallback, setFallback] = useState(false);
  // Closed until the viewport is measured. A narrow stage must not paint the
  // rail open beside the tutor drawer — that covers the image.
  const [paneOpen, setPaneOpen] = useState(false);
  const [narrow, setNarrow] = useState(true);
  const narrowRef = useRef(true);
  const expanded = native || fallback;
  const railSeries = useLazySeriesRail(series, mainImageReady, listedSeries);
  const showPane = seriesLoading || railSeries.length > 1;
  paneOpenRef.current = paneOpen;
  const railFloats = expanded || pane === "overlay";
  const toggleLabel = seriesRailToggleLabel({
    open: paneOpen,
    series: railSeries,
    activeIndex,
  });

  useLayoutEffect(() => {
    const mq = window.matchMedia(NARROW_LAYOUT_MEDIA);
    const apply = () => {
      const nextNarrow = mq.matches;
      narrowRef.current = nextNarrow;
      setNarrow(nextNarrow);
      setPaneOpen(readSeriesRailOpenForViewport(window.localStorage, nextNarrow));
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (
        event.key != null &&
        event.key !== SERIES_RAIL_STORAGE_KEY &&
        event.key !== SERIES_RAIL_NARROW_STORAGE_KEY
      ) {
        return;
      }
      setPaneOpen(readSeriesRailOpenForViewport(window.localStorage, narrowRef.current));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!focusToggle.current) return;
    focusToggle.current = false;
    const node = paneOpen ? openBtnRef.current : closedBtnRef.current;
    node?.focus();
  }, [paneOpen]);

  useEffect(() => {
    const onChange = () => {
      const live = document.fullscreenElement === rootRef.current;
      setNative(live);
      if (live) setFallback(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
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
    const nativeEntered = await requestStageFullscreen(el);
    if (!nativeEntered) setFallback(true);
  }, []);

  const toggle = useCallback(() => {
    if (expanded) void exit();
    else void enter();
  }, [enter, exit, expanded]);

  // A viewer toolbar inside the stage can take over the fullscreen control.
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => Math.max(0, n - 1));
  }, []);
  const stage = useMemo<ImagingStage>(
    () => ({ expanded, toggle, claim }),
    [expanded, toggle, claim]
  );

  const togglePane = useCallback((fromControl: boolean) => {
    if (fromControl) focusToggle.current = true;
    const next = !paneOpenRef.current;
    paneOpenRef.current = next;
    writeSeriesRailOpenForViewport(window.localStorage, narrowRef.current, next);
    setPaneOpen(next);
  }, []);

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
      if (e.key === SERIES_RAIL_TOGGLE_KEY && !e.repeat && showPane) {
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        if (isText(e.target)) return;
        e.preventDefault();
        togglePane(false);
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
  }, [expanded, exit, showPane, toggle, togglePane]);

  const body = typeof children === "function" ? children(expanded) : children;
  const railOpen = showPane && paneOpen;

  return (
    <ImagingStageContext.Provider value={stage}>
    <div
      ref={rootRef}
      className={cn(
        "relative flex min-w-0 max-w-full bg-imaging",
        fill && "h-full w-full",
        !fill && "w-full",
        fallback && "fixed inset-0 z-[70] h-dvh max-h-dvh w-full max-w-[100vw]",
        expanded &&
          "pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]",
        "[&:fullscreen]:h-full [&:fullscreen]:w-full [&:fullscreen]:bg-black",
        className
      )}
      data-narrow={narrow ? "true" : "false"}
    >
      {showPane && (
        <div
          data-series-rail={paneOpen ? "open" : "closed"}
          className={cn(
            "z-30 flex min-h-0 min-w-0 flex-col self-stretch",
            // In flow on every docked stage so the strip cannot cover the
            // slice readout or the toolbar. Fullscreen and exam cards float.
            railFloats ? "absolute inset-y-0 left-0" : "relative shrink-0",
            paneOpen
              ? railFloats
                ? "w-60 max-w-[calc(100%-9rem)]"
                : "w-[min(15rem,calc(100%-9rem))] lg:w-60"
              : "w-11",
            paneOpen && railFloats && "shadow-lg"
          )}
        >
          {/* Docked rail: absolute inset matches the image height so a long
              MRI list scrolls instead of stretching the page. Hidden, not
              unmounted, so middle-slice covers stay warm while collapsed. */}
          <div
            id={railId}
            hidden={!railOpen}
            className={cn(
              "relative min-h-0 min-w-0 flex-1 overflow-hidden border-r",
              railFloats || narrow
                ? "border-white/10 bg-[#121212]"
                : "border-subtle bg-surface",
              !railOpen && "hidden"
            )}
          >
            <SeriesNavigator
              series={railSeries}
              activeIndex={activeIndex}
              onSelect={(index) => onSelectSeries?.(index)}
              loading={seriesLoading && series.length === 0}
              appearance={railFloats || narrow ? "dark" : "paper"}
              className={cn("h-full min-h-0", !railFloats && "absolute inset-0")}
              headerAccessory={
                paneOpen ? (
                  <IconButton
                    ref={openBtnRef}
                    aria-label="Collapse series list"
                    aria-expanded={true}
                    aria-controls={railId}
                    aria-keyshortcuts={SERIES_RAIL_TOGGLE_KEY}
                    title="Collapse series list ([)"
                    size="md"
                    onClick={() => togglePane(true)}
                    className="h-11 w-11"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </IconButton>
                ) : null
              }
            />
          </div>
          {!paneOpen && (
            <IconButton
              ref={closedBtnRef}
              aria-label={toggleLabel}
              aria-expanded={false}
              aria-controls={railId}
              aria-keyshortcuts={SERIES_RAIL_TOGGLE_KEY}
              title={`${toggleLabel} ([)`}
              size="md"
              variant="ghost"
              onClick={() => togglePane(true)}
              className={cn(
                "h-auto min-h-11 w-11 flex-1 flex-col gap-1 rounded-none bg-[#121212] text-white",
                "ring-1 ring-inset ring-white/15 hover:bg-[#1c1c1c] hover:text-white",
                "focus-visible:ring-offset-0 active:scale-100"
              )}
            >
              <ChevronRight className="h-4 w-4 shrink-0" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-white [writing-mode:vertical-rl]">
                Series
              </span>
              {railSeries.length > 0 && (
                <span className="text-xs font-medium tabular-nums leading-none text-white/80">
                  {railSeries.length}
                </span>
              )}
            </IconButton>
          )}
        </div>
      )}

      <div
        className={cn(
          "relative min-w-0 flex-1",
          (fill || expanded) && "h-full min-h-0",
          // Floating rail paints over the image. Keep the readout and the
          // toolbar clear of that strip so tools stay one tap away.
          railFloats &&
            !paneOpen &&
            "[&_.imaging-readout]:left-12 [&_[role=toolbar]]:pl-12",
          railFloats &&
            paneOpen &&
            "[&_.imaging-readout]:left-[calc(min(15rem,100%-9rem)+0.5rem)] [&_[role=toolbar]]:pl-[min(15rem,calc(100%-9rem))]",
          railFloats && "[&_[role=toolbar]]:relative [&_[role=toolbar]]:z-40"
        )}
      >
        {body}
        {claims > 0 ? null : (
        <div className="pointer-events-none absolute right-[max(0.5rem,env(safe-area-inset-right))] top-[max(0.5rem,env(safe-area-inset-top))] z-40 flex items-center gap-1">
          <div className="pointer-events-auto">
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={expanded}
              aria-keyshortcuts="f"
              data-fullscreen-offer={narrow && !expanded ? "true" : undefined}
              aria-label={expanded ? "Exit fullscreen" : "Fullscreen viewer"}
              leadingIcon={
                expanded ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )
              }
              onClick={toggle}
              className={cn(
                "min-h-11 min-w-11 border border-white/25 bg-black/85 text-white shadow-lg",
                "hover:bg-[#1a1a1a] hover:text-white",
                // Labeled on a wide image. Icon-only below lg so a 44px control
                // stays prominent without covering the slice readout when the
                // series rail is open.
                "max-lg:h-11 max-lg:w-11 max-lg:gap-0 max-lg:px-0",
                "max-lg:ring-2 max-lg:ring-white/40"
              )}
            >
              <span className="max-lg:hidden">{expanded ? "Exit" : "Full screen"}</span>
            </Button>
          </div>
        </div>
        )}
        {expanded && fullscreenDock ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-[max(4.5rem,env(safe-area-inset-bottom))] z-50 flex justify-center px-3">
            <div className="pointer-events-auto rounded-full bg-black/80 p-1 ring-1 ring-white/20">
              {fullscreenDock}
            </div>
          </div>
        ) : null}
      </div>
    </div>
    </ImagingStageContext.Provider>
  );
}
