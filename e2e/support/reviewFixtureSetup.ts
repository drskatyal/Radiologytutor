// Synthetic local review fixture. No credentials, remote service or model calls.
import { readFile } from "node:fs/promises";
import { createFinding, mutateCase } from "../../lib/cases";
import { rebindPatch } from "../../lib/review/server";
import { startCapture, putCaptureChunk, completeCapture, reviewCapture } from "../../lib/journal/storage";
import { createHash } from "node:crypto";
import type { Finding } from "../../lib/types";
import type { CaptureChunk, ViewerSnapshot } from "../../lib/journal/types";
async function main() {
  const [orgId, caseId, renderedJSON] = process.argv.slice(2);
  if (!caseId?.startsWith("case-capture-") || !orgId || !process.env.DATA_DIR?.endsWith(".radlearn-tmp/radlearn-data")) throw new Error("Local synthetic fixture directory required");
  const rendered = JSON.parse(renderedJSON) as ViewerSnapshot;
  const study = JSON.parse(await readFile("fixtures/synthetic/study.json", "utf8"));
  const singles = study.instances.filter((i: { seriesUID: string }) => i.seriesUID === study.seriesUIDs[0]);
  const multi = study.instances.find((i: { frames: number }) => i.frames === 4);
  const targets = [singles[1], singles[2], multi, multi];
  const findings: Finding[] = [];
  for (let i = 0; i < targets.length; i++) {
    const instance = targets[i];
    const snapshot = { ...rendered, studyUID: study.studyUID, seriesUID: instance.seriesUID, sopUID: instance.sopUID, frame: i < 2 ? 1 : i,
      voi: { ww: i % 2 ? 400 : 1500, wc: i % 2 ? 40 : -600 }, camera: { ...rendered.camera, zoom: 1.25 + i / 10, pan: [8 + i, -6] as [number, number] }, invert: i % 2 === 0 };
    const base: Finding = { id: `review-${i + 1}`, order: i + 1, label: `Synthetic review finding ${i + 1}`, description: "Review the synthetic contour", teachingPoints: ["Compare adjacent images"], state: " ", marker: { shape: "circle", x_pct: .5, y_pct: .5 }, phiReview: { pixels: false, audio: false, screen: false } };
    const metadata = study.instances.filter((r: { seriesUID: string }) => r.seriesUID === instance.seriesUID).map((r: { metadata: unknown }) => r.metadata);
    findings.push({ ...base, ...rebindPatch(base, { snapshot, imagePoint: { x: 20, y: 20 }, dimensions: [64, 64] }, metadata) });
  }
  findings[0].measurements = [{ id: "review-length", kind: "length", label: "Synthetic diameter", handles: [[.2, .2], [.4, .2]], lengthMm: 8, sopInstanceUID: findings[0].sopInstanceUID, frameNumber: 1, resolvedAnchor: findings[0].resolvedAnchor }];
  findings[0].annotations = [{ label: "Synthetic contour", resolvedAnchor: findings[0].resolvedAnchor }];
  const captureId = "review-evidence";
  const manifest = await startCapture(orgId, caseId, captureId), snapshot = findings[0].resolvedAnchor!.snapshot!;
  const journal = [{ seq: 0, t: 0, kind: "render", renderSeq: snapshot.renderSeq, snapshot }, { seq: 1, t: 500, kind: "marker", renderSeq: snapshot.renderSeq, snapshot, payload: { markerId: "review-point", imagePoint: { x: 20, y: 20 }, dimensions: [64, 64] } }];
  const chunks: CaptureChunk[] = [];
  for (const [stream, bytes, mime] of [["journal", Buffer.from(JSON.stringify(journal)), "application/json"], ["audio", await readFile("fixtures/synthetic/narration.wav"), "audio/wav"]] as const) {
    const chunk: CaptureChunk = { seq: chunks.length, stream, tStart: stream === "audio" ? 200 : 0, tEnd: 1000, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mime }; chunks.push(chunk);
    await putCaptureChunk(orgId, caseId, captureId, chunk, bytes);
  }
  await completeCapture(orgId, caseId, captureId, { ...manifest, chunks, durationMs: 1000, offsets: { audio: 200 } });
  await reviewCapture(orgId, caseId, captureId, { pixels: true, audio: true, screen: true });
  findings[0].captureSessionId = captureId; findings[0].evidence = [{ tStart: 500, tEnd: 900, journalSeq: [0, 1] }];
  for (const finding of findings) await createFinding(orgId, caseId, finding);
  await mutateCase(orgId, caseId, data => ({ ...data, status: "published" }));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Fixture failed"); process.exitCode = 1; });
