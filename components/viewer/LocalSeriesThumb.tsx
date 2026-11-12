"use client";

// One series' thumbnail in the local viewer's series list.
//
// The row asks for its thumbnail only while it is on screen (an
// IntersectionObserver against the scrolling list) and withdraws the request
// if it scrolls away first. The thumbnailer (viewer-core/localThumbnails)
// holds nothing back until the first image is up, then fills one at a time.

import { useEffect, useRef, useSyncExternalStore } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { LocalThumbnailer, ThumbState } from "@flowrad/viewer-core/localThumbnails";

const IDLE: ThumbState = { status: "idle" };

export function LocalSeriesThumb({
  thumbs,
  seriesKey,
  imageId,
  dark = true,
  src = null,
}: {
  /**
   * A cover the source already serves (a cloud series' rendered middle slice).
   * Shown as-is; the on-device thumbnailer is not asked.
   */
  src?: string | null;
  thumbs: LocalThumbnailer | null;
  seriesKey: string;
  imageId: string | null;
  dark?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<{ key: string; state: ThumbState }>({ key: "", state: IDLE });
  const state = useSyncExternalStore(
    (onChange) => (thumbs ? thumbs.subscribe((key) => key === seriesKey && onChange()) : () => undefined),
    () => {
      if (!thumbs) return IDLE;
      const next = thumbs.peek(seriesKey);
      const prev = cacheRef.current;
      // Stable snapshot: same status (and URL) → same object.
      const same =
        prev.key === seriesKey &&
        prev.state.status === next.status &&
        (next.status !== "ready" || (prev.state.status === "ready" && prev.state.url === next.url));
      if (!same) cacheRef.current = { key: seriesKey, state: next };
      return cacheRef.current.state;
    },
    () => IDLE
  );

  useEffect(() => {
    const el = ref.current;
    if (src || !el || !thumbs || !imageId) return;
    if (typeof IntersectionObserver === "undefined") {
      thumbs.request(seriesKey, imageId);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) thumbs.request(seriesKey, imageId);
          else thumbs.cancel(seriesKey);
        }
      },
      // A row just below the fold is fetched before it scrolls in.
      { rootMargin: "120px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [thumbs, seriesKey, imageId, src]);

  const shown: ThumbState = src ? { status: "ready", url: src } : state;
  return (
    <div
      ref={ref}
      data-thumb-state={shown.status}
      className={cn(
        "relative aspect-square w-full overflow-hidden rounded-md bg-imaging",
        dark ? "ring-1 ring-white/10" : "ring-1 ring-subtle"
      )}
    >
      {shown.status === "ready" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={shown.url} alt="" draggable={false} className="h-full w-full object-contain" />
      ) : shown.status === "error" || !imageId ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <ImageOff className="h-5 w-5 text-white/50" aria-hidden />
        </div>
      ) : (
        // Skeleton, never a blank square (pulse while queued or decoding).
        <div className="absolute inset-0 animate-pulse bg-gradient-to-b from-white/[0.03] to-white/[0.08]" aria-hidden />
      )}
    </div>
  );
}
