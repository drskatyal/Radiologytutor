"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import type { Case, CaseData } from "@/lib/types";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { ReplayOverlayHandle } from "@/components/ReplayOverlay";
import { useResolvedSeries } from "@/components/viewer/useResolvedSeries";
import { RecordStage } from "@/components/record/RecordStage";
import { seriesHintFromCase } from "@/lib/viewerLoad";
import { caseSeriesToSource } from "@/lib/viewerSource";
import { FindingReviewPanel } from "./FindingReviewPanel";
export function FindingReviewWorkspace({ caseData, onChanged, onApprovedCount, onDirtyChange }: { onDirtyChange?: (id: string, dirty: boolean) => void; caseData: CaseData; onChanged: (data: Case) => void; onApprovedCount: (count: number) => void }) {
  const hints = useMemo(() => seriesHintFromCase(caseData, "/api/dicomweb"), [caseData.caseId]);
  const resolved = useResolvedSeries(caseData.caseId, hints), controls = useRef<CornerstoneControls | null>(null), overlay = useRef<ReplayOverlayHandle | null>(null);
  const [ready, setReady] = useState(false), [activeSeriesIndex, setActiveSeriesIndex] = useState(0);
  const onReady = useCallback((c: CornerstoneControls) => { controls.current = c; setReady(true); }, []);
  return <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
    {resolved.series.length > 0 ? <div className="overflow-hidden rounded-xl border border-subtle bg-imaging lg:sticky lg:top-24"><RecordStage source={caseSeriesToSource(resolved.series[0])} series={resolved.series} activeSeriesIndex={activeSeriesIndex} onSeriesChange={setActiveSeriesIndex} controls={controls} overlay={overlay} ready={ready} phase="idle" elapsedMs={0} progress={0} onReady={onReady} onEvent={() => {}} onCursor={() => {}} /></div> : <p role="status" className="text-sm text-secondary">Loading the study for review…</p>}
    <FindingReviewPanel caseData={caseData} viewer={controls} ready={ready} onChanged={onChanged} onApprovedCount={onApprovedCount} onDirtyChange={onDirtyChange} />
  </div>;
}
