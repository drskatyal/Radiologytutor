"use client";
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Button } from '@/components/ui';
import type { RenderConfirmedViewer } from '@/lib/viewerController';
import type { ReplayResult, ReplayState } from '@/lib/replay/types';
import type { approvedReplay } from '@/lib/replay/server';
import { startExactReplay } from '@/lib/replay/client';
export function ExactReplay({ caseId, findingId, viewer, onBusy }: { caseId: string; findingId: string; viewer: MutableRefObject<Partial<RenderConfirmedViewer> | null>; onBusy: (busy: boolean) => void }) {
  const run = useRef<ReturnType<typeof startExactReplay> | null>(null), mounted = useRef(true);
  const [state, setState] = useState<ReplayState | null>(null), [receipt, setReceipt] = useState('');
  const busy = !!state && ['loading', 'waiting', 'playing'].includes(state.phase);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; run.current?.cancel(); viewer.current?.showReplayGeometry?.([]); }; }, [viewer]);
  function start() {
    if (!viewer.current?.requestView || run.current && !run.current.done) return;
    setReceipt(''); onBusy(true);
    let source: Awaited<ReturnType<typeof approvedReplay>> | undefined;
    const url = `/api/cases/${encodeURIComponent(caseId)}/findings/${encodeURIComponent(findingId)}/replay`;
    const ctrl = startExactReplay(async signal => {
      const res = await fetch(url, { signal, cache: 'no-store' }), data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Replay unavailable'); source = data; return data;
    }, viewer.current as RenderConfirmedViewer, { onState: value => {
      if (mounted.current) setState(value);
      window.dispatchEvent(new CustomEvent('radlearn:replay', { detail: { type: 'state', ...value } }));
    }, onConfirmed: value => window.dispatchEvent(new CustomEvent('radlearn:replay', { detail: { type: 'confirmed', ...value } })) });
    run.current = ctrl;
    void ctrl.finished.then(async (result: ReplayResult) => {
      if (source) {
        try {
          const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: source.version, contentHash: source.contentHash, captureSessionId: source.captureSessionId, result }) });
          if (!res.ok) throw new Error();
          if (mounted.current) setReceipt('Replay receipt saved.');
        } catch { if (mounted.current) setReceipt('Replay receipt could not be saved. Retry when connected.'); }
      }
      if (mounted.current) onBusy(false);
    });
  }
  return <section className="rounded-lg border border-subtle bg-surface p-4 space-y-3" aria-label="Exact replay" data-replay-state={JSON.stringify(state)}>
    <div><h3 className="font-semibold text-primary">Replay approved take</h3><p className="text-sm text-secondary">Original recorded images, annotations and microphone audio. Text edits do not rewrite this evidence.</p></div>
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={start}>{state ? 'Replay again' : 'Start exact replay'}</Button><Button size="sm" variant="secondary" disabled={!busy} onClick={() => run.current?.cancel()}>Stop replay</Button></div>
    {state && <p role={state.phase === 'failed' ? 'alert' : 'status'} className={state.phase === 'failed' ? 'text-sm text-danger' : 'text-sm text-secondary'}>{state.message || 'Replaying confirmed images and recorded audio.'} <span aria-hidden="true" className="tabular-nums">{(state.elapsedMs / 1000).toFixed(2)} s</span></p>}
    {receipt && <p role="status" className="text-xs text-muted">{receipt}</p>}
  </section>;
}
