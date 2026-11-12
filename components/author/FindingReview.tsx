"use client";
import { useEffect, useId, useRef, useState, type MutableRefObject } from "react";
import { Check, Crosshair, History, Save } from "lucide-react";
import { Badge, Button, Card, Field, Input, Textarea } from "@/components/ui";
import type { Case, CaptureSession, Finding } from "@/lib/types";
import type { RenderConfirmedViewer } from "@/lib/viewerController";
import { matchesView } from "@/lib/journal/match";
import { annotationSummary, versionDiff, type FindingReviewState } from "@/lib/review/model";
import { captureReviewPoint, jumpToReview, reviewRequest } from "@/lib/review/client";
const textOf = (f: Finding) => ({ label: f.label, description: f.description, teachingPoints: f.teachingPoints.join("\n") });
const phiOf = (f: Finding) => f.phiReview ?? { pixels: false, audio: false, screen: false };
const clock = (t: number | null) => t === null ? "Unknown time" : `${Math.floor(t / 60000)}:${((t % 60000) / 1000).toFixed(2).padStart(5, "0")}`;
export function FindingReview({ caseId, review, viewer, ready, capture, onChanged, onReload, onEvidence, onDirtyChange }: {
  onDirtyChange?: (id: string, dirty: boolean) => void;
  caseId: string; review: FindingReviewState; viewer: MutableRefObject<Partial<RenderConfirmedViewer> | null>; ready: boolean;
  capture?: CaptureSession; onChanged: (data: Case) => void; onReload: () => Promise<void>; onEvidence: (session: CaptureSession, t: number) => void;
}) {
  const f = review.finding, id = useId(), base = useRef({ version: review.version, hash: review.contentHash });
  const original = useRef({ text: textOf(f), phi: phiOf(f) });
  const [text, setText] = useState(() => textOf(f)), [phi, setPhi] = useState(() => phiOf(f));
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState(""), [stale, setStale] = useState(false);
  const [jumpFailed, setJumpFailed] = useState(false);
  const [rendered, setRendered] = useState(false), [rebindOpen, setRebindOpen] = useState(false), [resolution, setResolution] = useState("");
  const renderedRef = useRef(false);
  const dirty = JSON.stringify(text) !== JSON.stringify(original.current.text) || JSON.stringify(phi) !== JSON.stringify(original.current.phi);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  useEffect(() => { onDirtyChange?.(f.id, dirty); return () => onDirtyChange?.(f.id, false); }, [f.id, dirty, onDirtyChange]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent);
  }, []);
  useEffect(() => {
    if (base.current.version === review.version && base.current.hash === review.contentHash) return;
    if (dirtyRef.current) { setStale(true); return; }
    base.current = { version: review.version, hash: review.contentHash }; original.current = { text: textOf(f), phi: phiOf(f) }; setText(textOf(f)); setPhi(phiOf(f)); setStale(false);
    setRendered(false); renderedRef.current = false;
  }, [review.version, review.contentHash, f]);
  useEffect(() => {
    if (!ready || !viewer.current) return;
    return viewer.current.onRendered?.(view => {
      if (renderedRef.current && (!review.snapshot || !matchesView(view.snapshot, review.snapshot))) { renderedRef.current = false; setRendered(false); }
    });
  }, [ready, viewer, review.snapshot]);
  const reason = jumpFailed ? "Image not confirmed: jump again or rebind before approval." : stale ? "This version changed. Discard your edits and reload before approving." : dirty ? "Save your changes before approving this version." : review.reasons[0];
  async function action(name: string, fn: () => Promise<void>) {
    setBusy(name); setError(""); setNotice("");
    try { await fn(); } catch (err) { if (name === "jump") setJumpFailed(true); setError(err instanceof Error ? err.message : "Review failed. Retry."); if ((err as { status?: number }).status === 409) setStale(true); }
    finally { setBusy(""); }
  }
  async function save(rebind = false) {
    await action(rebind ? "rebind" : "save", async () => {
      const data = await reviewRequest<Case>(`/api/cases/${encodeURIComponent(caseId)}/findings/${encodeURIComponent(f.id)}/review`, {
        expectedVersion: base.current.version, contentHash: base.current.hash,
        text: { ...text, teachingPoints: text.teachingPoints.split("\n") }, phiReview: phi,
        ...(rebind ? { rebind: captureReviewPoint(viewer.current), ...(f.extraction?.issues.length ? { resolveExtraction: { reason: resolution } } : {}) } : {}),
      });
      const next = data.findings.find(row => row.id === f.id)!;
      base.current = { version: next.currentVersion!, hash: data.findingVersions!.find(v => v.findingId === f.id && v.version === next.currentVersion)!.contentHash };
      original.current = { text: textOf(next), phi: phiOf(next) }; setText(textOf(next)); setPhi(phiOf(next)); setStale(false); setJumpFailed(false); setRebindOpen(false); renderedRef.current = false; setRendered(false);
      onChanged(data); setNotice(`Saved v${next.currentVersion}. Needs review.`);
    });
  }
  const measurements = f.measurements ?? [], annotations = f.annotations ?? [];
  return <Card padded={false} className="min-w-0 overflow-hidden [&_button]:min-h-11 [&_input]:scroll-mt-28 [&_textarea]:scroll-mt-28 [&_button]:scroll-mt-28 [&_summary]:scroll-mt-28" onFocusCapture={event => {
      const target = event.target as HTMLElement, bounds = target.getBoundingClientRect();
      // The studio header is fixed; native focus scrolling does not account for it.
      if (target.matches(":focus-visible") && (bounds.top < 96 || bounds.bottom > window.innerHeight - 24)) target.scrollIntoView({ block: "center", behavior: "instant" });
    }} data-testid={`finding-review-${f.id}`} aria-labelledby={`${id}-title`}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-subtle px-4 py-3">
      <div className="min-w-0"><h3 id={`${id}-title`} className="break-words text-sm font-semibold text-primary">{f.label || "Untitled finding"}</h3>
        <div className="mt-2 flex flex-wrap gap-2"><Badge variant={review.approved && !dirty && !stale ? "success" : "warning"}>{review.approved && !dirty && !stale ? `Approved v${review.version}` : "Needs review"}</Badge>
          {review.anchorStatus !== "resolved" && <Badge variant="neutral">Incomplete image anchor</Badge>}
          <span className="text-xs text-muted">Version {review.version}</span>
        </div>
      </div>
      <Button variant="secondary" size="sm" leadingIcon={<Crosshair className="h-4 w-4" />} disabled={!ready || !!busy || !review.snapshot || review.anchorStatus !== "resolved"}
        aria-describedby={`${id}-anchor`} onClick={() => void action("jump", async () => {
          renderedRef.current = false; setRendered(false);
          await jumpToReview(viewer.current, review); setJumpFailed(false); renderedRef.current = true; setRendered(true);
        })}>{busy === "jump" ? "Waiting for render…" : "Jump"}</Button>
    </div>
    <div className="space-y-4 p-4">
      <div id={`${id}-anchor`} className="space-y-1 text-xs text-secondary" data-sop={review.snapshot?.sopUID} data-frame={review.snapshot?.frame}>
        <p role="status">{rendered ? "Rendered ✓" : review.anchorStatus === "unresolved" ? review.reasons.find(r => r.includes("Image")) ?? "Image not found: rebind" : !review.snapshot ? "Full image view incomplete: rebind" : `Frame ${review.snapshot.frame} · ${f.resolvedAnchor?.calibration ?? "Uncalibrated"}`}</p>
        {review.snapshot && <details><summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Image identity</summary><p className="mt-1 break-all">SOP {review.snapshot.sopUID} · frame {review.snapshot.frame}</p></details>}
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Finding evidence">
        {(f.evidence ?? []).map((e, i) => <Button key={i} size="sm" variant="ghost" disabled={!capture?.manifest || e.tStart === null || e.tStart < 0 || e.tStart > capture.durationMs || !capture.manifest.chunks.some(c => c.stream !== "journal")}
          onClick={() => capture && e.tStart !== null && onEvidence(capture, e.tStart)} title={`Journal events ${e.journalSeq.join(", ") || "unknown"}`}>
          Evidence {clock(e.tStart)}–{clock(e.tEnd)}{e.estimated ? " · estimated" : ""}
        </Button>)}
        {!f.evidence?.length && <p className="text-xs text-muted">No timed media evidence recorded.</p>}
      </div>
      <Field label="Label" required>{p => <Input {...p} value={text.label} maxLength={200} disabled={!!busy} onChange={e => setText({ ...text, label: e.target.value })} />}</Field>
      <Field label="Description">{p => <Textarea {...p} rows={3} value={text.description} maxLength={6000} disabled={!!busy} onChange={e => setText({ ...text, description: e.target.value })} />}</Field>
      <Field label="Teaching points" hint="One point per line.">{p => <Textarea {...p} rows={3} value={text.teachingPoints} disabled={!!busy} onChange={e => setText({ ...text, teachingPoints: e.target.value })} />}</Field>
      <details className="rounded-lg border border-subtle p-3"><summary className="cursor-pointer rounded text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Annotations and measurements ({annotations.length + measurements.length})</summary>
        {!annotations.length && !measurements.length && <p className="mt-2 text-xs text-muted">No annotations or measurements on this version.</p>}
        <ul className="mt-2 space-y-2 text-sm">{measurements.map(m => <li key={m.id} className="flex flex-wrap items-center gap-2"><span>{m.label || m.kind}{m.lengthMm !== undefined ? ` · ${m.lengthMm.toFixed(2)} mm` : ""}</span><Badge variant={m.resolvedAnchor?.calibration && m.resolvedAnchor.calibration !== "uncalibrated" ? "info" : "warning"}>{m.resolvedAnchor?.calibration ?? "uncalibrated"}</Badge><span className="text-xs text-muted">Frame {m.frameNumber ?? "unknown"}</span></li>)}
          {annotations.map((a, i) => { const row = annotationSummary(a); return <li key={i} className="flex flex-wrap items-center gap-2"><span>Annotation {i + 1}{row.label ? `: ${row.label}` : ""}</span><Badge variant={row.calibration === "uncalibrated" ? "warning" : "info"}>{row.calibration}</Badge><span className="text-xs text-muted">Frame {row.frame ?? "unknown"}</span></li>; })}</ul>
      </details>
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium text-primary">Patient identifier review</legend>
        {([['pixels', 'Images contain no patient identifiers'], ['audio', 'Audio contains no patient identifiers'], ['screen', 'Screen recording contains no patient identifiers']] as const).map(([key, label]) => <label key={key} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-secondary"><Input type="checkbox" className="h-4 w-4 shrink-0 accent-accent" checked={phi[key]} disabled={!!busy} onChange={e => setPhi({ ...phi, [key]: e.target.checked })} />{label}</label>)}
      </fieldset>
      <div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" leadingIcon={<Save className="h-4 w-4" />} disabled={!!busy || stale || !text.label.trim() || (!dirty && !review.reasons.some(r => r.includes("Save a new version")))} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save new version"}</Button>
        <Button variant="ghost" size="sm" disabled={!ready || !!busy || stale} onClick={() => setRebindOpen(!rebindOpen)} aria-expanded={rebindOpen}>Rebind anchor</Button>
      </div>
      {rebindOpen && <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
        <p className="text-sm text-secondary">Set the image and view, then pan the finding to the viewport centre. Rebinding replaces this version&apos;s geometry; earlier annotations and measurements stay in history.</p>
        {!!f.extraction?.issues.length && <Field label="Evidence review" hint={`Resolve: ${f.extraction.issues.join(", ")}. Explain your correction; estimated times remain marked.`}>{p => <Textarea {...p} value={resolution} rows={2} onChange={e => setResolution(e.target.value)} />}</Field>}
        <Button size="sm" disabled={!!busy || (!!f.extraction?.issues.length && resolution.trim().length < 8)} onClick={() => void save(true)}>Use current view and centre point</Button>
      </div>}
      <div className="space-y-2 border-t border-subtle pt-4">
        <Button leadingIcon={<Check className="h-4 w-4" />} disabled={!!busy || dirty || stale || jumpFailed || !review.canApprove} aria-describedby={`${id}-approval-reason`} onClick={() => void action("approve", async () => {
          const data = await reviewRequest<Case>(`/api/cases/${encodeURIComponent(caseId)}/findings/${encodeURIComponent(f.id)}/approve`, { version: base.current.version, contentHash: base.current.hash });
          onChanged(data); setNotice(`Approval recorded for v${review.version}.`);
        })}>{review.approved && !dirty && !stale ? "Approval current" : `Approve v${review.version}`}</Button>
        <p id={`${id}-approval-reason`} className="text-xs text-secondary">{reason ?? (review.approved ? "Changes will create a new version that needs approval." : "Approval applies to this saved version and its image evidence.")}</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {notice && <p role="status" className="text-sm text-success">{notice}</p>}
        {(stale || error) && <Button variant="secondary" size="sm" onClick={() => void action("reload", async () => { dirtyRef.current = false; original.current = { text: textOf(f), phi: phiOf(f) }; base.current = { version: review.version, hash: review.contentHash }; setStale(false); setError(""); setText(textOf(f)); setPhi(phiOf(f)); await onReload(); })}>Discard edits and reload</Button>}
      </div>
      <details className="border-t border-subtle pt-3"><summary className="flex cursor-pointer items-center gap-2 rounded text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><History className="h-4 w-4" />Version history ({review.versions.length})</summary>
        <ol className="mt-3 space-y-3">{[...review.versions].reverse().map(v => <li key={v.version} className="rounded-lg border border-subtle p-3 text-xs"><p className="font-medium">v{v.version}{v.parentVersion ? ` from v${v.parentVersion}` : " · initial version"} · {new Date(v.createdAt).toLocaleString()}</p><details className="mt-2"><summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Changes in v{v.version}</summary><dl className="mt-2 space-y-2">{versionDiff(review.versions.find(p => p.version === v.parentVersion), v).map(d => <div key={d.field}><dt className="font-medium text-primary">{d.field}</dt><dd className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-secondary"><del>{d.before}</del><br /><ins>{d.after}</ins></dd></div>)}</dl></details></li>)}</ol>
      </details>
    </div>
  </Card>;
}
