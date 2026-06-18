"use client";

// Pacsbin iframe + transparent overlay + finding marker.
// Used by BOTH author (capture marker via click) and playback (render +
// animate marker). The iframe src is set imperatively via the ref so the
// animation runner can update it ~25fps without React re-render churn.

import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type { Marker } from "@/lib/types";

export interface ViewerFrameHandle {
  /** Set the iframe URL directly (used by the animation runner). */
  setSrc: (url: string) => void;
  getSrc: () => string;
}

interface Props {
  initialSrc: string;
  /** If set, clicking the overlay reports the point as percentages. */
  onOverlayClick?: (x_pct: number, y_pct: number) => void;
  /** Marker to render (author preview or playback). */
  marker?: Marker | null;
  /** Fade the marker in (playback reveal). */
  markerVisible?: boolean;
  className?: string;
}

const ViewerFrame = forwardRef<ViewerFrameHandle, Props>(function ViewerFrame(
  { initialSrc, onOverlayClick, marker, markerVisible = true, className },
  ref
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentSrc, setCurrentSrc] = useState(initialSrc);

  useImperativeHandle(ref, () => ({
    setSrc: (url: string) => {
      setCurrentSrc(url);
      if (iframeRef.current) iframeRef.current.src = url;
    },
    getSrc: () => iframeRef.current?.src ?? currentSrc,
  }));

  function handleClick(e: MouseEvent<HTMLDivElement>) {
    if (!onOverlayClick || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x_pct = (e.clientX - rect.left) / rect.width;
    const y_pct = (e.clientY - rect.top) / rect.height;
    onOverlayClick(
      Math.min(1, Math.max(0, x_pct)),
      Math.min(1, Math.max(0, y_pct))
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative bg-black overflow-hidden ${className ?? ""}`}
    >
      <iframe
        ref={iframeRef}
        src={initialSrc}
        className="absolute inset-0 h-full w-full border-0"
        allow="autoplay"
        title="Pacsbin viewer"
      />

      {/* Transparent overlay. pointer-events only when capturing clicks so the
          iframe stays interactive during authoring navigation otherwise. */}
      <div
        onClick={handleClick}
        className="absolute inset-0"
        style={{ pointerEvents: onOverlayClick ? "auto" : "none" }}
      >
        {marker && (
          <Marker marker={marker} visible={markerVisible} />
        )}
      </div>
    </div>
  );
});

function Marker({ marker, visible }: { marker: Marker; visible: boolean }) {
  const style = {
    left: `${marker.x_pct * 100}%`,
    top: `${marker.y_pct * 100}%`,
    opacity: visible ? 1 : 0,
    transition: "opacity 0.4s ease-out",
  } as const;

  if (marker.shape === "arrow") {
    return (
      <div
        className={`absolute -translate-x-1/2 -translate-y-full ${visible ? "marker-fade-in" : ""}`}
        style={style}
      >
        <div className="text-yellow-400 text-3xl leading-none drop-shadow-[0_0_4px_rgba(0,0,0,0.9)]">
          ↓
        </div>
      </div>
    );
  }

  return (
    <div
      className={`absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-yellow-400 marker-pulse ${
        visible ? "marker-fade-in" : ""
      }`}
      style={style}
    />
  );
}

export default ViewerFrame;
