import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";

test.use({ storageState: { cookies: [], origins: [] } });

test("approved tool route requires a session and never reveals its catalog anonymously", async ({ request }) => {
  for (const method of ["get", "post"] as const) {
    const response = await request[method]("/api/cases/case-synthetic-teach/approved-tools", { data: { name: "point_to", args: { anchorId: "invented" } } });
    expect(response.status()).toBe(401);
    expect(await response.text()).not.toContain("CANARY");
  }
});

test("real routes expose approved IDs and metadata bounds, reject forged geometry, and invalidate old commands after edit", async ({ page, context }) => {
  await page.goto("/viewer/local");
  const api = (url: string, data?: unknown, method = "POST") => page.evaluate(async ({ url, data, method }) => {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  }, { url, data, method });
  await context.clearCookies();
  expect((await api("/api/auth/sign-up/email", { name: "Synthetic Tool Author", email: `synthetic-tools-${Date.now()}@example.test`, password: "synthetic-local-test-password" })).status).toBe(200);
  const caseId = `case-tools-${Date.now()}`;
  const created = await api("/api/cases", { caseId, title: "Synthetic tool test", modality: "CT", pacsbinBaseUrl: "https://pacsbin.com/viewer/case/synthetic" });
  expect(created.status).toBe(200);
  await promisify(execFile)(process.execPath, ["--import", "tsx", "e2e/support/approvalFixture.ts", created.data.orgId, caseId], { cwd: process.cwd(), env: { ...process.env, MONGODB_URI: "", DATA_DIR: path.join(process.cwd(), ".radlearn-tmp", "radlearn-data") } });
  const fixture = JSON.parse(await readFile("fixtures/synthetic/case.json", "utf8"));
  const base = fixture.findings[0];
  const identity = { studyUID: base.studyInstanceUID, seriesUID: base.seriesInstanceUID, sopUID: base.sopInstanceUID, frame: 1 };
  const finding = { ...base, frameNumber: 1, imagePoint: { x: 16, y: 32 }, phiReview: { pixels: true, audio: true, screen: true }, annotations: [{ ...identity, shape: "arrow", from: [0.1, 0.2], to: [0.25, 0.5], tool: "ArrowAnnotate" }] };
  expect((await api(`/api/cases/${caseId}/findings`, finding)).status).toBe(200);
  const url = `/api/cases/${caseId}/approved-tools`;
  expect((await api(url, undefined, "GET")).data.anchors).toEqual([]);
  const versions = await api(`/api/cases/${caseId}/findings/${finding.id}/versions`, undefined, "GET");
  const v = versions.data.at(-1);
  expect((await api(`/api/cases/${caseId}/findings/${finding.id}/approve`, { version: v.version, contentHash: v.contentHash })).status).toBe(200);
  const catalog = await api(url, undefined, "GET");
  expect(catalog.status).toBe(200);
  expect(catalog.data.series[0].frameCount).toBe(4);
  const anchorId = catalog.data.anchors[0].id;
  const annotationId = catalog.data.annotations[0].id;
  for (const [name, args] of [["point_to", { anchorId }], ["draw_annotation", { annotationId }], ["scroll_to", { sliceIndex: 0 }]]) {
    const result = await api(url, { name, args });
    expect(result.status).toBe(200);
    expect(result.data.action.target).toEqual(identity);
  }
  for (const [name, args] of [
    ["point_to", { anchorId, x_pct: 0.25, y_pct: 0.5 }], ["point_to", { findingId: finding.id }],
    ["draw_annotation", { annotationId, tool: "Length", x_pct: 0.25 }], ["draw_annotation", { findingId: finding.id }],
    ["scroll_to", { sliceIndex: 4 }], ["scroll_to", { sliceIndex: -1 }], ["scroll_to", { sliceIndex: 1 }],
    ["scroll_to", { sliceIndex: "0" }], ["scroll_to", { sliceIndex: 0.5 }], ["scroll_to", { sliceIndex: 0, seriesInstanceUID: "1.2.999" }],
    ["set_series", { sliceIndex: 4, seriesInstanceUID: identity.seriesUID }],
  ]) expect((await api(url, { name, args, context: { frameCount: 999, anchors: [anchorId] } })).status).toBe(422);
  expect((await api(`/api/cases/${caseId}/findings/${finding.id}/versions`, { expectedVersion: 1, patch: { description: "Synthetic expert edit" } })).status).toBe(200);
  expect((await api(url, undefined, "GET")).data.anchors).toEqual([]);
  expect((await api(url, { name: "point_to", args: { anchorId } })).status).toBe(422);
  expect((await api(url, { name: "draw_annotation", args: { annotationId } })).status).toBe(422);
  // A new session has no access to another org's catalog.
  await context.clearCookies();
  expect((await api("/api/auth/sign-up/email", { name: "Synthetic Other Author", email: `synthetic-other-${Date.now()}@example.test`, password: "synthetic-local-test-password" })).status).toBe(200);
  expect((await api(url, undefined, "GET")).status).toBe(404);
});
