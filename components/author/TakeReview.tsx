"use client";

// Review surface after Finish. The video is the DICOM viewport recording.
// The timeline is the viewer log on the same clock. Nothing here calls Gemini.

import { useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui";
import { reviewTimeline } from "@/lib/teacherCapture";
import type { RecordedTrack } from "@/lib/types";

export interface TeacherReview {
  videoUrl: string | null;
  audioUrl: string | null;
  videoOffsetMs: number;
  audioOffsetMs: number;
  track: RecordedTrack;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function TakeReview({ review }: { review: TeacherReview }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const duration = Math.max(review.track.durationMs, 1);
  const marks = reviewTimeline(review.track);

  function mediaMs(fromVideo: boolean): number {
    if (fromVideo && videoRef.current && review.videoUrl) {
      return Math.min(duration, Math.max(0, videoRef.current.currentTime * 1000 + review.videoOffsetMs));
    }
    if (audioRef.current && review.audioUrl) {
      return Math.min(duration, Math.max(0, audioRef.current.currentTime * 1000 + review.audioOffsetMs));
    }
    return t;
  }

  function seek(ms: number) {
    const next = Math.min(duration, Math.max(0, ms));
    setT(next);
    if (videoRef.current && review.videoUrl) {
      videoRef.current.currentTime = Math.max(0, (next - review.videoOffsetMs) / 1000);
    }
    if (audioRef.current && review.audioUrl) {
      audioRef.current.currentTime = Math.max(0, (next - review.audioOffsetMs) / 1000);
    }
  }

  function toggle() {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (playing) {
      video?.pause();
      audio?.pause();
      setPlaying(false);
      return;
    }
    void video?.play().catch(() => {});
    void audio?.play().catch(() => {});
    setPlaying(true);
  }

  return (
    <div className="mt-3 rounded-xl border border-subtle bg-canvas/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-primary">Recording review</p>
        <p className="font-mono text-[11px] tabular-nums text-muted">
          {formatClock(t)} / {formatClock(duration)}
        </p>
      </div>
      {review.videoUrl ? (
        <video
          ref={videoRef}
          src={review.videoUrl}
          className="mb-3 aspect-video w-full rounded-lg bg-black"
          playsInline
          onTimeUpdate={() => setT(mediaMs(true))}
          onSeeked={() => {
            const ms = mediaMs(true);
            setT(ms);
            const audio = audioRef.current;
            if (!audio || !review.audioUrl) return;
            const next = Math.max(0, (ms - review.audioOffsetMs) / 1000);
            if (Math.abs(audio.currentTime - next) > 0.25) audio.currentTime = next;
          }}
          onEnded={() => setPlaying(false)}
        />
      ) : (
        <p className="mb-3 text-xs text-muted">
          Viewport video isn&apos;t available for this take. Scrub the viewer log — slice, window,
          series, and compare share this clock.
        </p>
      )}
      {review.audioUrl ? <audio ref={audioRef} src={review.audioUrl} onEnded={() => setPlaying(false)} /> : null}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          aria-label={playing ? "Pause recording" : "Play recording"}
          onClick={toggle}
          leadingIcon={playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        >
          {playing ? "Pause" : "Play"}
        </Button>
        <input
          type="range"
          className="h-2 w-full accent-accent"
          min={0}
          max={duration}
          step={100}
          value={Math.min(t, duration)}
          aria-label="Recording timeline"
          onChange={(e) => seek(Number(e.target.value))}
        />
      </div>
      {marks.length > 0 && (
        <ul className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
          {marks.map((mark, index) => (
            <li key={`${mark.t}-${mark.label}-${index}`}>
              <button
                type="button"
                className="rounded-md border border-subtle bg-elevated px-2 py-1 text-[11px] text-secondary hover:border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                onClick={() => seek(mark.t)}
              >
                <span className="font-mono tabular-nums text-muted">{formatClock(mark.t)}</span> {mark.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
