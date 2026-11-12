import test from "node:test";
import assert from "node:assert/strict";
import { processRetainedCapture } from "./client";
test("M6 browser caller sends only operation/marker decisions and commits the persisted job before reloading", async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  const markerDecisions = [{ kind: "omit" as const, markerIds: ["marker-1"], reason: "Accidental mark" }];
  const mock: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return Response.json(requests.length === 1 ? { id: "job", status: "ready" } : requests.length === 2 ? { id: "job", status: "committed" } : { findings: [{ label: "Later edit" }] });
  };
  const data = await processRetainedCapture("case", "take", markerDecisions, mock);
  assert.equal(data.findings[0].label, "Later edit");
  assert.deepEqual(requests.map(r => r.body), [{ action: "extract", retry: true, markerDecisions }, { action: "commit", jobId: "job" }, undefined]);
});
test("M6 browser handles typed unavailable/conflict results and never commits a failed job", async () => {
  for (const [status, errorCode, message] of [["failed", "MODEL_UNAVAILABLE", /capture is retained/], ["conflict", "VERSION_CONFLICT", /edit was kept/]] as const) {
    let calls = 0;
    await assert.rejects(processRetainedCapture("case", "take", [], async () => { calls++; return Response.json({ status, errorCode }, { status: 503 }); }), message);
    assert.equal(calls, 1);
  }
});
