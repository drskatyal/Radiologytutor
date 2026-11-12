import { hashContent } from "../findingContent";
import { anchorFields } from "../anchors/materialize";
import { reconcileMarkers, type MarkerAssignment, type MarkerDecision } from "../anchors/reconcile";
import type { CaptureSession, Finding } from "../types";
import type { ExtractProposal } from "./schema";
import type { ExtractionJob, ExtractDraft } from "./types";
import type { GeminiRequestMetadata } from "../geminiMetadata";
import { measurementsFromTrack } from "../findingMeasurements";

export const MIN_EXTRACTION_CONFIDENCE = 0.8;
export function materializeExtraction(session: CaptureSession, job: Pick<ExtractionJob, "id" | "baseFindings">, proposals: ExtractProposal[], metadata: GeminiRequestMetadata, decisions: MarkerDecision[] = []): ExtractDraft[] {
  const journal = session.journal ?? session.track.journal ?? [], duration = session.durationMs;
  const stream = (name: string) => session.manifest!.chunks.some(c => c.stream === name);
  const issues = proposals.map(p => {
    const out = new Set<string>();
    if (p.confidence === null || p.confidence < MIN_EXTRACTION_CONFIDENCE) out.add("low_confidence");
    if (!p.dictatedOrVisual) out.add("missing_source");
    if ((p.dictatedOrVisual === "dictated" || p.dictatedOrVisual === "both") && !stream("audio")) out.add("missing_audio");
    if ((p.dictatedOrVisual === "visual" || p.dictatedOrVisual === "both") && !stream("video")) out.add("missing_video");
    if (!p.evidence.length) out.add("missing_evidence");
    for (const e of p.evidence) {
      const valid = e.tStart !== null && e.tEnd !== null && e.tStart >= 0 && e.tEnd > e.tStart && e.tEnd <= duration;
      if (!valid || e.estimated) out.add("invalid_interval");
      if (valid && journal.some(j => j.kind === "discontinuity" && j.t >= e.tStart! && j.t <= e.tEnd!)) out.add("discontinuous_interval");
      if (!e.journalSeq.length) out.add("missing_journal_reference");
      for (const seq of e.journalSeq) {
        const entry = journal.find(j => j.seq === seq);
        if (!entry) out.add("unknown_journal_reference");
        else if (valid && (entry.t < e.tStart! || entry.t > e.tEnd!)) out.add("journal_outside_interval");
      }
    }
    return out;
  });
  for (let i = 0; i < proposals.length; i++) for (let j = i; j < proposals.length; j++) {
    for (let a = 0; a < proposals[i].evidence.length; a++) for (let b = 0; b < proposals[j].evidence.length; b++) {
      if (i === j && a >= b) continue;
      const x = proposals[i].evidence[a], y = proposals[j].evidence[b];
      if (x.tStart !== null && x.tEnd !== null && y.tStart !== null && y.tEnd !== null && x.tEnd > x.tStart && y.tEnd > y.tStart && x.tStart < y.tEnd && y.tStart < x.tEnd) {
        issues[i].add("overlapping_interval"); issues[j].add("overlapping_interval");
      }
    }
  }
  proposals.forEach((p, i) => { if (issues[i].size) p.evidence.forEach(e => { e.estimated = true; }); });
  const reconciled = reconcileMarkers(journal, decisions), used = new Set<number>();
  const assignments: Array<{ assignment?: MarkerAssignment; indexes: number[] }> = reconciled.drafts.map(assignment => {
    const markerEntry = journal.find(e => e.seq === assignment.resolvedAnchor.journalSeq.at(-1));
    let indexes = proposals.flatMap((p, i) => p.markerId && assignment.markerIds.includes(p.markerId) ? [i] : []);
    if (!indexes.length && markerEntry) indexes = proposals.flatMap((p, i) => !p.markerId && p.evidence.some(e => e.tStart !== null && e.tEnd !== null && e.tStart <= markerEntry.t && e.tEnd >= markerEntry.t) ? [i] : []);
    indexes.forEach(i => used.add(i));
    return { assignment, indexes };
  });
  proposals.forEach((_p, i) => {
    if (assignments.filter(a => a.indexes.includes(i)).length > 1) issues[i].add("ambiguous_marker_window");
  });
  proposals.forEach((p, i) => {
    if (p.markerId && reconciled.omitted.some(d => d.markerIds.includes(p.markerId!))) used.add(i);
    if (!used.has(i)) assignments.push({ indexes: [i] });
  });
  return assignments.map(({ assignment, indexes }, i) => {
    const proposal = indexes.length ? proposals[indexes[0]] : undefined;
    const problems = new Set(indexes.flatMap(index => [...issues[index]]));
    if (!proposal) problems.add("missing_proposal");
    if (!assignment) problems.add("unresolved_marker");
    const fields = anchorFields(session.track, assignment ?? {});
    if (fields.anchorStatus !== "resolved") problems.add("unresolved_anchor");
    if (assignment && proposal) {
      const markerSeq = assignment.resolvedAnchor.journalSeq.at(-1);
      if (!proposal.evidence.some(e => markerSeq !== undefined && e.journalSeq.includes(markerSeq))) problems.add("marker_evidence_missing");
    }
    const evidence = indexes.flatMap(index => structuredClone(proposals[index].evidence));
    if (problems.size) evidence.forEach(e => { e.estimated = true; });
    const markerId = assignment?.markerId;
    const previous = markerId ? job.baseFindings.find(f => f.markerId === markerId) : undefined;
    const id = previous?.id ?? `ex_${hashContent({ session: session.id, marker: markerId ?? `${job.id}:proposal:${i}` }).slice(0, 24)}`;
    const finding: Finding = { id, label: proposal?.label ?? `Marker candidate ${i + 1}`, description: indexes.map(index => proposals[index].description).filter(Boolean).join("\n"),
      teachingPoints: [...new Set(indexes.flatMap(index => proposals[index].teachingPoints))], state: " ", order: i + 1,
      marker: { x_pct: .5, y_pct: .5, shape: "circle" }, ...fields,
      captureSessionId: session.id, segmentId: `extraction:${job.id}:${i}`, evidence,
      phiReview: structuredClone(session.manifest!.phiReview),
      provenance: { instanceSetFingerprint: "", orderingAlgorithmVersion: "", modelId: metadata.requestedModel, promptVersion: "" },
      extraction: { jobId: job.id, proposalIndexes: indexes, dictatedOrVisual: proposal?.dictatedOrVisual ?? null, confidence: proposal?.confidence ?? null, issues: [...problems], modelMetadata: metadata },
    };
    if (!fields.marker) delete (finding as Partial<Finding>).marker;
    // Only retained native measurements referenced by evidence may be attached.
    const seqs = new Set(evidence.flatMap(e => e.journalSeq));
    finding.measurements = measurementsFromTrack(session.track).filter(m => m.resolvedAnchor?.journalSeq.some(seq => seqs.has(seq) && journal.find(e => e.seq === seq)?.kind === "annotation"));
    // Resolution uses the complete journal, including later edits/removals.
    // A model reference cannot resurrect an old measurement revision.
    const anchors = finding.groupedAnchors?.length ? finding.groupedAnchors : finding.resolvedAnchor ? [finding.resolvedAnchor] : [];
    if (finding.measurements.some(m => !anchors.some(a => a.snapshot?.sopUID === m.sopInstanceUID && a.snapshot?.frame === m.frameNumber))) problems.add("measurement_anchor_mismatch");
    finding.extraction!.issues = [...problems];
    if (problems.size) evidence.forEach(e => { e.estimated = true; });
    if (problems.size) {
      finding.anchorStatus = "unresolved"; delete finding.anchor;
      if (finding.resolvedAnchor) finding.resolvedAnchor.anchorStatus = "unresolved";
    }
    return { id: `draft_${i + 1}`, proposalIndexes: indexes, issues: [...problems], finding, expectedVersion: previous?.version ?? 0, sourceKey: hashContent({ job: job.id, finding: id }) };
  });
}
