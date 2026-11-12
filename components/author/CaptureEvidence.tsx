"use client";
import { useEffect, useRef, useState } from "react";
import { Card, Spinner } from "@/components/ui";
import type { CaptureSession } from "@/lib/types";
import { evidenceMediaTime } from "@/lib/review/model";
export function CaptureEvidence({ caseId, selection }: { caseId: string; selection: { session: CaptureSession; t: number; request: number } | null }) {
  const [media, setMedia] = useState<Array<{ stream: "audio" | "video"; url: string; offset: number }>>([]), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const box = useRef<HTMLDivElement>(null), target = useRef(selection); target.current = selection;
  useEffect(() => {
    setMedia([]); setError("");
    if (!selection) return;
    const controller = new AbortController(), urls: string[] = [];
    setLoading(true); box.current?.scrollIntoView({ behavior: "auto", block: "nearest" });
    void (async () => {
      try {
        const rows = [];
        for (const stream of ["video", "audio"] as const) {
          if (!selection.session.manifest?.chunks.some(c => c.stream === stream)) continue;
          const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}/capture-sessions/${encodeURIComponent(selection.session.id)}/media?stream=${stream}`, { signal: controller.signal, cache: "no-store" });
          if (!res.ok) throw new Error("Evidence media unavailable. Retry the evidence button.");
          const blob = await res.blob(); if (controller.signal.aborted) return;
          const url = URL.createObjectURL(blob); urls.push(url);
          rows.push({ stream, url, offset: selection.session.manifest.offsets[stream] ?? 0 });
        }
        if (!controller.signal.aborted) setMedia(rows);
      } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Media unavailable"); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => { controller.abort(); urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [caseId, selection?.session.id, selection?.request]);
  if (!selection) return null;
  const seek = (element: HTMLMediaElement, offset: number) => {
    const value = evidenceMediaTime(target.current!.t, offset, selection.session.durationMs);
    if (value !== null) element.currentTime = value;
    else setError("This evidence time is outside the retained media stream.");
  };
  return <div ref={box}><Card className="space-y-3" data-testid="capture-evidence" aria-label="Evidence media">
    <h3 className="text-sm font-semibold text-primary">Evidence recording</h3>
    <p className="text-xs text-secondary">Capture time {(selection.t / 1000).toFixed(2)} s. Media offsets are applied. Review the recording before approving.</p>
    {loading && <p role="status" className="flex items-center gap-2 text-sm"><Spinner size="sm" />Loading evidence…</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {media.map(m => m.stream === "video" ? <video key={m.url} aria-label="Evidence video" controls playsInline preload="auto" className="aspect-video w-full rounded-lg bg-black" src={m.url} onLoadedMetadata={e => seek(e.currentTarget, m.offset)} onError={() => setError("Video could not be decoded. Retry the evidence button.")} /> : <audio key={m.url} aria-label="Evidence audio" controls preload="auto" className="w-full" src={m.url} onLoadedMetadata={e => seek(e.currentTarget, m.offset)} onError={() => setError("Audio could not be decoded. Retry the evidence button.")} />)}
  </Card></div>;
}
