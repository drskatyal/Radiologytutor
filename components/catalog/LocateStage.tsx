"use client";

// The imaging surface for a click-the-finding assessment question.
//
// This mounts the SAME Cornerstone viewer the student learns on, loaded with
// the real study the finding was authored against and driven to the authored
// slice/window. That is the whole point of the question type: a normalized
// [0,1] click is only meaningful if the learner is looking at the anatomy the
// marker was placed on.
//
// The answer never reaches the browser — /api/assessments/question-view returns
// viewport state and no marker, and grading stays server-side.

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { Crosshair, ImageOff, Target } from "lucide-react";
import { Spinner } from "@/components/ui";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { CaseSeries, ViewerSource } from "@/lib/viewerSource";

const CornerstoneViewer = dynamic(() => import("@/components/CornerstoneViewer"), {
  ssr: false,
  loading: () => <StageMessage spinner label="Loading viewer…" />,
});

/** Viewport state for the authored view — deliberately marker-free. */
interface QuestionView {
  seriesInstanceUID?: string;
  sliceIndex?: number;
  windowWidth?: number;
  windowCenter?: number;
}

interface QuestionViewPayload {
  hasImaging: boolean;
  source: ViewerSource | null;
  series: CaseSeries[];
  modality?: string;
  view?: QuestionView;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; payload: QuestionViewPayload }
  | { status: "no-imaging" }
  | { status: "error"; message: string };

export function LocateStage({
  courseId,
  questionId,
  answer,
  onLocate,
}: {
  courseId: string;
  questionId: string;
  /** The learner's current pick, in normalized [0,1] viewport space. */
  answer?: { x_pct?: number; y_pct?: number };
  onLocate: (x_pct: number, y_pct: number) => void;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [viewerReady, setViewerReady] = useState(false);
  const controls = useRef<CornerstoneControls | null>(null);
  const hitRef = useRef<HTMLButtonElement>(null);

  // Re-fetch whenever the learner moves to a different locate question.
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setViewerReady(false);
    controls.current = null;

    const params = new URLSearchParams({ courseId, questionId });
    fetch(`/api/assessments/question-view?${params}`, { credentials: "include" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Couldn't load this question's imaging.");
        return data as QuestionViewPayload;
      })
      .then((payload) => {
        if (cancelled) return;
        if (!payload.hasImaging || !payload.source) {
          setState({ status: "no-imaging" });
          return;
        }
        setState({ status: "ready", payload });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Couldn't load this question's imaging.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [courseId, questionId]);

  // Drive the viewer to the authored view once both it and the payload exist.
  const handleReady = useCallback(
    (c: CornerstoneControls) => {
      controls.current = c;
      setViewerReady(true);
      if (state.status !== "ready") return;
      const view = state.payload.view;
      if (!view) return;
      if (
        view.seriesInstanceUID &&
        c.seriesUIDs.includes(view.seriesInstanceUID) &&
        c.activeSeriesUID !== view.seriesInstanceUID
      ) {
        c.showSeries(view.seriesInstanceUID);
      }
      // No animation: the learner should be looking at the target view from the
      // first frame, not watching it fly there.
      void c.showState(
        {
          sliceIndex: view.sliceIndex,
          windowWidth: view.windowWidth,
          windowCenter: view.windowCenter,
        },
        0
      );
    },
    [state]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      const el = hitRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      onLocate(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)));
    },
    [onLocate]
  );

  const placed =
    answer?.x_pct !== undefined && answer?.y_pct !== undefined
      ? { x: answer.x_pct, y: answer.y_pct }
      : null;

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
        Scroll and window as you would in the reading room, then click the finding.
      </p>

      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border border-strong bg-imaging">
        {state.status === "loading" && <StageMessage spinner label="Loading study…" />}

        {state.status === "no-imaging" && (
          <StageMessage
            icon
            label="This question's study isn't available right now."
            detail="Ask your administrator to check the imaging backend — we won't grade a click without the image."
          />
        )}

        {state.status === "error" && (
          <StageMessage icon label="Couldn't load this question's imaging." detail={state.message} />
        )}

        {state.status === "ready" && state.payload.source && (
          <>
            <CornerstoneViewer
              source={state.payload.source}
              series={state.payload.series}
              modality={state.payload.modality}
              controls={controls}
              onReady={handleReady}
              instanceId={`locate-${questionId}`}
              showToolbar={false}
            />

            {!viewerReady && <StageMessage spinner label="Preparing series…" />}

            {/* Click layer sits above the canvas and captures the normalized
                point. Keyboard users get the same target via focus + Enter,
                which lands centre-frame — imperfect, but never a dead end. */}
            <button
              ref={hitRef}
              type="button"
              onClick={handleClick}
              className="absolute inset-0 z-10 cursor-crosshair focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
              aria-label="Click the image where the finding is located"
            />

            {placed && (
              <span
                className="pointer-events-none absolute z-20 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-accent bg-accent/30 text-accent"
                style={{ left: `${placed.x * 100}%`, top: `${placed.y * 100}%` }}
                aria-hidden="true"
              >
                <Target className="h-3 w-3" />
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Centred status message over the imaging surface. */
function StageMessage({
  spinner,
  icon,
  label,
  detail,
}: {
  spinner?: boolean;
  icon?: boolean;
  label: string;
  detail?: string;
}) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-imaging px-6 text-center">
      {spinner && <Spinner />}
      {icon && <ImageOff className="h-5 w-5 text-muted" aria-hidden="true" />}
      <p className="text-sm text-secondary">{label}</p>
      {detail && <p className="max-w-sm text-xs text-muted">{detail}</p>}
    </div>
  );
}
