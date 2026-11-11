"use client";
import { useMemo, useState } from "react";
import { ViewerFrame } from "@/components/viewer/ViewerFrame";
import { Button, Field, Textarea, Badge } from "@/components/ui";
import { seriesHintFromCase } from "@/lib/viewerLoad";
import { examInitialView, type LearnerSafeCase } from "@/lib/exam/projection";

/** This component cannot accept raw CaseData; its only case prop is branded safe. */
export function ExamSession({ caseData, attemptId }: { caseData: LearnerSafeCase; attemptId: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<number | null>(null);
  const series = useMemo(() => seriesHintFromCase({ modality: caseData.modality, studyRefs: caseData.studyRefs, findings: [] }, "/api/dicomweb"), [caseData]);
  const source = useMemo(() => ({ kind: "cloud" as const, series, label: caseData.title }), [series, caseData.title]);
  async function submit() {
    if (!text.trim()) { setError("Describe your observations before submitting."); return; }
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/exam/sessions/${attemptId}/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: { kind: "report", text }, close: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Answer could not be saved. Try again.");
      setResult(data.score.score);
    } catch (e) { setError(e instanceof Error ? e.message : "Answer could not be saved. Try again."); }
    finally { setBusy(false); }
  }
  return <main className="flex h-dvh flex-col bg-canvas" data-testid="exam-session">
    <header className="flex items-center justify-between gap-3 border-b border-subtle bg-surface px-4 py-3">
      <h1 className="text-base font-semibold text-primary">Imaging examination</h1>
      <Badge variant="neutral">{result === null ? "In progress" : "Completed"}</Badge>
    </header>
    <div className="min-h-0 flex-1">
      <ViewerFrame source={source} initial={examInitialView} />
    </div>
    <section className="border-t border-subtle bg-surface p-4">
      {result !== null ? <p role="status" className="text-primary">Attempt completed. Score: {result}%.</p> : <form className="mx-auto flex max-w-4xl flex-col gap-3" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <p className="text-sm text-secondary">{caseData.stem}</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Field label="Your observations" error={error ?? undefined}>{props => <Textarea {...props} rows={2} value={text} onChange={e => setText(e.target.value)} disabled={busy} />}</Field>
        <Button type="submit" disabled={busy || !text.trim()} className="self-end">{busy ? "Saving answer…" : "Submit and finish"}</Button>
      </form>}
    </section>
  </main>;
}
