"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ViewerFrame } from '@/components/viewer/ViewerFrame';
import { Button, Field, Textarea, Badge, MicButton, Tabs } from '@/components/ui';
import { useRecorder, type Recording } from '@/components/useRecorder';
import type { CornerstoneControls } from '@/components/CornerstoneViewer';
import { seriesHintFromCase } from '@/lib/viewerLoad';
import { examInitialView, type LearnerSafeCase } from '@/lib/exam/projection';
import { examinerPromptPack } from '@/lib/exam/prompt';
import { captureExamPoint } from '@/lib/exam/point';
import { HoldToTalk, bindHoldKeys } from '@/lib/tutor/holdToTalk';
import type { publicExamAttempt } from '@/lib/exam/attempt';
import type { ExamPoint } from '@/lib/exam/types';
import type { TeachingLayer } from '@/lib/teachingLayer';
import { assertNoPhi } from '@/lib/phiGuard';
type Receipt = ReturnType<typeof publicExamAttempt>;
type Reveal = { rubricVersion: string; items: { item: number; label: string; description: string; phrases: string[]; teachingPoints: string[]; point?: ExamPoint }[] };
/** The case prop contains no reference findings; reveal is fetched only after close. */
export function ExamSession({ caseData, attemptId }: { caseData: LearnerSafeCase; attemptId: string }) {
  const [receipt, setReceipt] = useState<Receipt | null>(null), [text, setText] = useState(''), [point, setPoint] = useState<ExamPoint | null>(null);
  const [mode, setMode] = useState('report'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [reviewed, setReviewed] = useState(false), [transcriptReviewed, setTranscriptReviewed] = useState(false), [assisted, setAssisted] = useState(false);
  const [mic, setMic] = useState<'idle' | 'recording' | 'processing'>('idle'), [reveal, setReveal] = useState<Reveal | null>(null);
  const recorder = useRecorder(), controls = useRef<CornerstoneControls | null>(null), host = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null), audioUrl = useRef<string | null>(null), voiceAbort = useRef<AbortController | null>(null), generation = useRef(0);
  const base = `/api/exam/sessions/${encodeURIComponent(attemptId)}`, active = receipt?.status === 'active';
  const series = useMemo(() => seriesHintFromCase({ modality: caseData.modality, studyRefs: caseData.studyRefs, findings: [] }, '/api/dicomweb'), [caseData]);
  const source = useMemo(() => ({ kind: 'cloud' as const, series, label: caseData.title }), [series, caseData.title]);
  const stopVoice = useCallback(() => { generation.current++; voiceAbort.current?.abort(); audio.current?.pause(); audio.current = null; if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); audioUrl.current = null; setMic('idle'); }, []);
  async function json(url: string, body?: unknown) {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Request failed. Try again.'); return d;
  }
  const load = useCallback(async () => {
    try { const r: Receipt = await json(base); setReceipt(r); const latest = r.answers.filter(a => a.round === r.round && a.answer.kind !== 'point').at(-1)?.answer; if (latest && latest.kind !== 'point') setText(latest.text); }
    catch (e) { setError((e as Error).message); }
  }, [base]);
  useEffect(() => { void load(); const url = new URL(window.location.href); url.searchParams.set('attempt', attemptId); window.history.replaceState(null, '', url); return stopVoice; }, [load, attemptId, stopVoice]);
  async function operate(action: 'hint' | 'retry' | 'close') {
    if (!receipt) return; stopVoice(); setBusy(true); setError('');
    try { const next: Receipt = await json(base, { action, revision: receipt.revision, requestId: crypto.randomUUID() }); setReceipt(next);
      if (action === 'retry') { setText(''); setPoint(null); setTranscriptReviewed(false); setNotice('New try started. Previous answers remain in your attempt history.'); }
      if (action === 'hint') setNotice(examinerPromptPack().hints[Math.min(next.hintCount - 1, 1)]);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function submit(close = false) {
    if (!receipt) return; stopVoice(); setBusy(true); setError('');
    try { const answer = mode === 'point' ? point && { kind: 'point', ...point } : { kind: mode === 'voice' ? 'text' : 'report', text };
      if (!answer) throw new Error('Select a point on the image first.'); assertNoPhi(answer);
      const current: Receipt = await json(base);
      if (current.round !== receipt.round) throw new Error('Another try started in this session. Reload before saving.');
      const r: Receipt = await json(`${base}/answer`, { answer, close, assisted, revision: current.revision, requestId: crypto.randomUUID() }); setReceipt(r); setNotice('Answer saved. Feedback is available after you finish.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const callbacks = useRef({ recorder, active, reviewed, busy, mode }); callbacks.current = { recorder, active, reviewed, busy, mode };
  const hold = useRef<HoldToTalk<Recording> | null>(null);
  if (!hold.current) hold.current = new HoldToTalk({
    recorder: { start: () => callbacks.current.recorder.start(), stop: () => callbacks.current.recorder.stop() }, interrupt: stopVoice,
    state: (s, message) => { setMic(s === 'idle' ? 'idle' : 'recording'); if (message) setNotice(message); },
    submit: async rec => {
      const token = generation.current, controller = new AbortController(); voiceAbort.current = controller; setMic('processing'); setError('');
      try { const r = await fetch(`${base}/transcribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ audio: { base64: rec.base64, mime: rec.mimeType, phiReviewed: true } }) }); const data = await r.json();
        if (token !== generation.current || !callbacks.current.active) return;
        if (!r.ok) throw new Error(data.error || 'Transcription failed'); assertNoPhi(data.transcript); setText(data.transcript); setTranscriptReviewed(false); setNotice('Review the transcript, remove any identifiers, then save your answer.');
      } catch (e) { if (token === generation.current) setError((e as Error).message); } finally { if (token === generation.current) setMic('idle'); }
    },
  });
  const startMic = useCallback(() => { const c = callbacks.current; if (!c.active || c.busy || c.mode !== 'voice') return; if (!c.reviewed) { setError('Confirm that your recording contains no patient identifiers.'); return; } hold.current?.press(); }, []);
  useEffect(() => bindHoldKeys(window, document, { press: repeat => { if (!repeat) startMic(); }, release: reason => { hold.current?.release(reason); if (reason && !['release', 'maximum'].includes(reason)) stopVoice(); } }, () => !callbacks.current.active || callbacks.current.mode !== 'voice'), [startMic, stopVoice]);
  useEffect(() => () => { hold.current?.release('cancel'); stopVoice(); }, [stopVoice]);
  const teaching = useMemo<TeachingLayer>(() => ({ bindControls: i => i === 0 ? controls : null,
    onPaneClick: (pane, p) => { if (pane.index !== 0 || mode !== 'point' || !active || busy) return;
      const box = host.current?.querySelector('[data-viewer-snapshot]')?.getBoundingClientRect(); if (!box) return;
      try { setPoint(captureExamPoint(controls.current, (p.clientX - box.left) / box.width, (p.clientY - box.top) / box.height)); setError(''); setNotice('Point selected on the displayed image. Save it when ready.'); } catch (e) { setError((e as Error).message); }
    },
  }), [mode, active, busy]);
  async function playPrompt() {
    stopVoice(); const token = generation.current, controller = new AbortController(); voiceAbort.current = controller; setError('');
    let url: string | undefined;
    try { const r = await fetch(`${base}/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ kind: receipt?.hintCount ? 'hint' : 'opening' }) });
      if (!r.ok) throw new Error((await r.json()).error); const blob = await r.blob(); if (token !== generation.current) return;
      url = URL.createObjectURL(blob); audioUrl.current = url; const player = new Audio(url); audio.current = player; player.onended = () => { if (url) URL.revokeObjectURL(url); if (audioUrl.current === url) audioUrl.current = null; }; await player.play();
    } catch (e) { if (url) URL.revokeObjectURL(url); if (token === generation.current) setError((e as Error).message); }
  }
  const canSubmit = mode === 'point' ? !!point : !!text.trim() && (mode !== 'voice' || transcriptReviewed);
  return <main className="flex h-dvh flex-col bg-canvas" data-testid="exam-session" data-attempt-id={attemptId}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-subtle bg-surface px-4 py-3"><h1 className="text-base font-semibold text-primary">Imaging examination</h1><Badge variant="neutral">{receipt?.status === 'closed' ? 'Completed' : 'In progress'}</Badge></header>
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(16rem,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-1">
    {/* Reading mode sizes the canvas to its grid cell; page mode uses a square image that can overflow it. */}
    <div ref={host} className="relative min-h-0 min-w-0 overflow-hidden"><ViewerFrame tone="reading" source={source} initial={examInitialView} teaching={teaching} /></div>
    <section className="min-h-0 min-w-0 overflow-y-auto border-t border-subtle bg-surface p-4 lg:border-l lg:border-t-0" aria-label="Examination response">
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        {error && <p role="alert" className="text-sm text-danger">{error} <Button size="sm" variant="ghost" onClick={() => void load()}>Reload attempt</Button></p>}
        {receipt?.status === 'closed' ? <>
          <p role="status" className="text-primary">Attempt completed. Score: {receipt.score?.score ?? 0}%.</p>
          <p className="text-sm text-secondary">{receipt.score?.assisted ? 'Assisted answer' : 'Unassisted answer'} · {receipt.hintCount} hints · {receipt.retryCount} retries</p>
          <ul className="text-sm text-secondary">{receipt.score?.evidence.map(e => <li key={e.item}>Finding {e.item}: {e.correct ? 'Matched' : 'Not matched'}{e.assisted ? ' (assisted)' : ''}</li>)}</ul>
          <Button variant="secondary" disabled={busy || !!reveal} onClick={async () => { setBusy(true); try { setReveal(await json(`${base}/reveal`)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>Reveal reference answers</Button>
          {reveal && <div aria-label="Reference answers">{reveal.items.map(item => <article key={item.item} className="border-t border-subtle py-3"><h2 className="font-medium text-primary">{item.label}</h2><p className="text-sm text-secondary">{item.description}</p><ul>{item.phrases.map((phrase, i) => <li key={i}>{phrase}</li>)}</ul>{item.point && <p className="text-sm text-muted">Reference image {item.point.sopUID}, frame {item.point.frame}; pixel ({item.point.imagePoint.x}, {item.point.imagePoint.y})</p>}</article>)}</div>}
        </> : <>
          <p className="text-sm text-secondary">{caseData.stem}</p>
          {!receipt ? <p role="status">Loading attempt…</p> : <>
            <div className="flex flex-wrap items-center gap-2"><Tabs items={[{ value: 'report', label: 'Report' }, { value: 'point', label: 'Point' }, { value: 'voice', label: 'Voice' }]} value={mode} onValueChange={value => { hold.current?.release('cancel'); stopVoice(); setMic('idle'); setMode(value); }} /><Button size="sm" variant="ghost" disabled={busy || mic !== 'idle'} onClick={() => void operate('hint')}>Neutral hint</Button><Button size="sm" variant="ghost" disabled={busy || mic !== 'idle'} onClick={() => void playPrompt()}>Hear prompt</Button></div>
            {mode === 'point' ? <><p className="text-sm text-secondary">Click a point on the displayed image, or centre it and use the keyboard button.</p><Button variant="secondary" size="sm" disabled={busy} onClick={() => { try { setPoint(captureExamPoint(controls.current, .5, .5)); setNotice('Centre point selected.'); } catch (e) { setError((e as Error).message); } }}>Select image centre</Button>{point && <p data-testid="exam-point" className="text-sm text-muted">Selected frame {point.frame}, pixel ({point.imagePoint.x.toFixed(1)}, {point.imagePoint.y.toFixed(1)})</p>}</> : <>
              {mode === 'voice' && <><label className="flex min-h-8 items-center gap-2 text-sm text-secondary"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />My recording contains no patient identifiers.</label><MicButton holdToTalk state={mic} onStart={startMic} onStop={() => hold.current?.release()} onCancel={() => hold.current?.release('cancel')} disabled={!recorder.supported || busy} /><p className="text-xs text-muted">Hold Space to record; release to transcribe. Escape discards the recording.</p></>}
              <Field label={mode === 'voice' ? 'Review your transcript' : 'Your observations'}>{props => <Textarea {...props} rows={2} value={text} onChange={e => { setText(e.target.value); setTranscriptReviewed(false); }} disabled={busy} />}</Field>
              {mode === 'voice' && <label className="flex min-h-8 items-center gap-2 text-sm text-secondary"><input type="checkbox" checked={transcriptReviewed} onChange={e => setTranscriptReviewed(e.target.checked)} />I reviewed this transcript and removed identifiers.</label>}
            </>}
            <label className="flex min-h-8 items-center gap-2 text-sm text-secondary"><input type="checkbox" checked={assisted} onChange={e => setAssisted(e.target.checked)} />I used additional assistance.</label>
            <p className="text-xs text-muted">{receipt.answerCount} answers saved · {receipt.hintCount} hints · {receipt.retryCount} retries</p>
            {notice && <p role="status" className="text-sm text-secondary">{notice}</p>}
            <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" disabled={busy || mic !== 'idle'} onClick={() => void operate('retry')}>Start another try</Button><Button variant="secondary" disabled={busy || !canSubmit || mic !== 'idle'} onClick={() => void submit()}>Save answer</Button><Button disabled={busy || mic !== 'idle' || (!canSubmit && !receipt.answers.some(a => a.round === receipt.round))} onClick={() => void (canSubmit ? submit(true) : operate('close'))}>{busy ? 'Saving answer…' : 'Submit and finish'}</Button></div>
          </>}
        </>}
      </div>
    </section>
    </div>
  </main>;
}
