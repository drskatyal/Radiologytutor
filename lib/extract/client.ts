import type { Case } from "../types";
import type { ExtractionJob } from "./types";
const messages: Record<string, string> = {
  MODEL_UNAVAILABLE: "AI extraction is unavailable. The capture is retained; configure Gemini or use notes, then retry.",
  PHI_REVIEW_REQUIRED: "Patient identifier review is required before extraction can continue.",
  EXTRACTION_FAILED: "Extraction failed. The capture is retained; retry processing.",
  VERSION_CONFLICT: "A finding changed after extraction started. Your edit was kept; review the draft before saving.",
};
export async function processRetainedCapture(caseId: string, sessionId: string, markerDecisions: import("../anchors/reconcile").MarkerDecision[] = [], fetchImpl: typeof fetch = fetch): Promise<Case> {
  const base = `/api/cases/${encodeURIComponent(caseId)}/capture-sessions/${encodeURIComponent(sessionId)}/extract`;
  async function request(url: string, body?: unknown): Promise<ExtractionJob> {
    const res = await fetchImpl(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
    const data = await res.json();
    if (!res.ok || data.status === "failed" || data.status === "conflict") throw new Error(messages[data.errorCode] ?? data.error ?? "Extraction request failed; retry from the retained capture.");
    return data;
  }
  let job = await request(base, { action: "extract", retry: true, markerDecisions });
  const deadline = Date.now() + 15 * 60 * 1000;
  while (job.status === "running") {
    if (Date.now() >= deadline) throw new Error("Extraction is still running. The capture is retained; retry to check its status.");
    await new Promise(resolve => setTimeout(resolve, 1000));
    job = await request(`${base}?jobId=${encodeURIComponent(job.id)}`);
  }
  if (job.status !== "committed") await request(base, { action: "commit", jobId: job.id });
  const res = await fetchImpl(`/api/cases/${encodeURIComponent(caseId)}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Drafts saved. Reload the case to view them.");
  return res.json();
}
