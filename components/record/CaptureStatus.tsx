"use client";
import { useEffect, useState, type MutableRefObject } from "react";
import { Button, Card, Input } from "@/components/ui";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { UseRecordReplay } from "./useRecordReplay";
import { captureLocalStore } from "@/lib/journal/localStore";

/** Capture recovery and verification; this is not the M7 finding approval surface. */
export function CaptureStatus({ rr, controls }: { rr: UseRecordReplay; controls: MutableRefObject<CornerstoneControls | null> }) {
  const [pending, setPending] = useState<Record<string, number>>({});
  const [viewStatus, setViewStatus] = useState("");
  const [checking, setChecking] = useState(false);
  const [reviewChecked, setReviewChecked] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => { setReviewChecked(false); setViewStatus(""); }, [rr.track?.captureSessionId]);
  useEffect(() => {
    let active = true;
    void Promise.all((rr.recoverable ?? []).map(async local => [local.manifest.sessionId, (await captureLocalStore.chunks(local.manifest.sessionId)).filter(c => !c.acked).length] as const))
      .then(rows => { if (active) setPending(Object.fromEntries(rows)); }).catch(() => {});
    return () => { active = false; };
  }, [rr.recoverable]);
  const restore = async () => {
    const viewer = controls.current;
    const snapshot = rr.track?.journal?.find(e => e.kind === "render")?.snapshot;
    const current = viewer?.getRenderedView?.()?.snapshot;
    if (!viewer?.requestView || !snapshot || !current) { setViewStatus("Recorded image is unavailable."); return; }
    setChecking(true); setViewStatus("Waiting for the recorded image to render…");
    try {
      // A restored tab has a new pane ID; the image and all view values stay exact.
      await viewer.requestView({ commandId: crypto.randomUUID(), generation: 0, snapshot: { ...snapshot, viewportId: current.viewportId }, timeoutMs: 5000 });
      setViewStatus("Recorded image rendered and confirmed.");
    } catch { setViewStatus("Recorded image was not confirmed. Check that the series is available, then retry."); }
    finally { setChecking(false); }
  };
  return <div className="mt-3 space-y-3" data-testid="capture-status">
    {rr.phase === "starting" && <p role="status" className="text-sm text-secondary">Starting capture — waiting for the first microphone sample…</p>}
    {rr.phase === "stopping" && <p role="status" className="text-sm text-secondary">Retaining capture and checking server acknowledgements…</p>}
    {rr.captureError && <p role="alert" className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-primary">{rr.captureError}</p>}
    {["starting", "recording"].includes(rr.phase) && !!rr.pendingMarkers?.length && <Card className="space-y-2 rounded-lg bg-surface p-3" data-testid="pending-markers">
      <p className="text-sm text-primary">{rr.pendingMarkers.length} retained markers</p>
      <Button size="sm" variant="secondary" onClick={() => rr.undoMarker?.()}>Undo last marker (Alt+Z)</Button>
      <ul className="space-y-1">{rr.pendingMarkers.map((entry, i) => <li key={String(entry.payload?.markerId)} className="flex items-center justify-between gap-2 text-xs text-secondary">
        <span>Marker {i + 1} · frame {entry.snapshot?.frame ?? "unresolved"}</span>
        <Button size="sm" variant="ghost" aria-label={`Remove marker ${i + 1}`} onClick={() => rr.removeMarker?.(String(entry.payload?.markerId))}>Remove</Button>
      </li>)}</ul>
    </Card>}
    {!!rr.acknowledgedChunks && <p role="status" className="text-xs text-secondary">{rr.acknowledgedChunks} capture chunks acknowledged by the server.</p>}
    {(rr.recoverable ?? []).map(local => <Card key={local.manifest.sessionId} className="rounded-lg bg-surface p-3">
      <p className="text-sm text-primary">Retained recording · {local.manifest.chunks.length} chunks</p>
      <p className="mt-1 text-xs text-secondary">{pending[local.manifest.sessionId] ?? "Checking"} awaiting acknowledgement. Recovery checks server receipts and sends missing chunks.</p>
      <Button className="mt-2" variant="secondary" size="sm" disabled={rr.phase !== "idle"} onClick={() => void rr.recover?.(local.manifest.sessionId)}>
        {local.closed ? "Retry capture sync" : "Recover recording"}
      </Button>
    </Card>)}
    {rr.track?.captureSessionId && <Card className="space-y-2 rounded-lg bg-surface p-3">
      <Button variant="secondary" size="sm" disabled={rr.phase !== "idle" || checking} onClick={() => void restore()}>{checking ? "Waiting for render…" : "Restore captured view"}</Button>
      {viewStatus && <p role="status" className="text-sm text-secondary">{viewStatus}</p>}
      {rr.mediaReviewed ? <p className="text-sm text-success">Media PHI review recorded.</p> : <>
        <label className="flex items-start gap-2 text-sm text-secondary">
          <Input type="checkbox" className="mt-1 h-4 w-4 shrink-0 p-0 accent-accent" checked={reviewChecked} onChange={e => setReviewChecked(e.target.checked)} />
          I reviewed the captured images, audio and viewport video and found no patient identifiers.
        </label>
        <Button size="sm" variant="secondary" disabled={!reviewChecked || reviewing || rr.phase !== "idle"} onClick={async () => { setReviewing(true); try { await rr.reviewMedia?.(); } finally { setReviewing(false); } }}>Save media review</Button>
      </>}
    </Card>}
  </div>;
}
