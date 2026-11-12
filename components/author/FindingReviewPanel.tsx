"use client";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { Button, Spinner } from "@/components/ui";
import { FindingReview } from "./FindingReview";
import { ExactReplay } from "./ExactReplay";
import { CaptureEvidence } from "./CaptureEvidence";
import type { Case, CaseData, CaptureSession } from "@/lib/types";
import type { RenderConfirmedViewer } from "@/lib/viewerController";
import type { CaseReview } from "@/lib/review/model";
import { reviewRequest } from "@/lib/review/client";
export function FindingReviewPanel({ caseData, viewer, ready, onChanged, onApprovedCount, onDirtyChange }: {
  onDirtyChange?: (id: string, dirty: boolean) => void;
  caseData: CaseData; viewer: MutableRefObject<Partial<RenderConfirmedViewer> | null>; ready: boolean; onChanged: (data: Case) => void; onApprovedCount?: (count: number) => void;
}) {
  const [review, setReview] = useState<CaseReview | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<{ session: CaptureSession; t: number; request: number } | null>(null);
  const [replaying, setReplaying] = useState(false), [replayFinding, setReplayFinding] = useState<string | null>(null);
  const generation = useRef(0), countCallback = useRef(onApprovedCount); countCallback.current = onApprovedCount;
  const reload = useCallback(async () => {
    const next = ++generation.current; setLoading(true); setError(""); countCallback.current?.(0);
    try {
      const data = await reviewRequest<CaseReview>(`/api/cases/${encodeURIComponent(caseData.caseId)}/review`);
      if (next === generation.current) { setReview(data); countCallback.current?.(data.findings.filter(f => f.approved).length); }
    } catch (err) { if (next === generation.current) setError(err instanceof Error ? err.message : "Review unavailable"); }
    finally { if (next === generation.current) setLoading(false); }
  }, [caseData.caseId]);
  const revision = JSON.stringify([caseData.updatedAt, caseData.findings.map(f => [f.id, f.currentVersion, f.approvedVersion, f.status])]);
  useEffect(() => { setReplaying(false); void reload(); return () => { generation.current++; }; }, [reload, revision]);
  return <section className="mt-6 min-w-0 space-y-4" aria-label="Finding approval review">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold text-primary">Review and approve findings</h2><p className="mt-1 text-sm text-secondary">Check the exact image and evidence. Each edit needs a new approval.</p></div><Button variant="secondary" size="sm" disabled={loading || replaying} onClick={() => void reload()}>Refresh review</Button></div>
    {loading && <p role="status" className="flex items-center gap-2 text-sm text-secondary"><Spinner size="sm" />Verifying current versions and images…</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {replayFinding && <ExactReplay key={`${replayFinding}-${revision}`} caseId={caseData.caseId} findingId={replayFinding} viewer={viewer} onBusy={setReplaying} />}
    <fieldset disabled={replaying} className="min-w-0 space-y-4">
    <CaptureEvidence caseId={caseData.caseId} selection={selection} />
    {!error && review && [...review.findings].sort((a, b) => a.finding.order - b.finding.order).map(row => <FindingReview key={row.finding.id} caseId={caseData.caseId} review={loading ? { ...row, canApprove: false, approved: false, reasons: ["Verifying current image evidence…", ...row.reasons] } : row} viewer={viewer} ready={ready && !loading}
      capture={review.caseData.captureSessions?.find(s => s.id === row.finding.captureSessionId)} onChanged={onChanged} onDirtyChange={onDirtyChange} onReload={reload} onReplay={() => setReplayFinding(row.finding.id)} onEvidence={(session, t) => setSelection({ session, t, request: Date.now() })} />)}
    {!loading && !error && review?.findings.length === 0 && <p className="text-sm text-muted">Record or add a finding to begin approval review.</p>}
    </fieldset>
  </section>;
}
