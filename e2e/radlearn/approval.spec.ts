import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("author approves two exact findings; editing one invalidates its badge and tutor retrieval", async ({ page, context }) => {
  await page.goto("/viewer/local");
  const api = (url: string, data?: unknown, method = "POST") => page.evaluate(async ({ url, data, method }) => {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: r.status, data: await r.json() };
  }, { url, data, method });
  // The intentional production demo restriction remains intact.
  expect((await api("/api/cases/case-synthetic-teach/findings/synthetic-1/approve", { version: 1, contentHash: "fake" })).status).toBe(403);
  await context.clearCookies();
  const signup = await api("/api/auth/sign-up/email", { name: "Synthetic Test Author", email: `synthetic-${Date.now()}@example.test`, password: "synthetic-local-test-password" });
  expect(signup.status).toBe(200);
  const caseId = `case-approval-${Date.now()}`;
  const created = await api("/api/cases", { caseId, title: "Synthetic approval test", modality: "CT", pacsbinBaseUrl: "https://pacsbin.com/viewer/case/synthetic" });
  expect(created.status).toBe(200);
  await promisify(execFile)(process.execPath, ["--import", "tsx", "e2e/support/approvalFixture.ts", created.data.orgId, caseId], { cwd: process.cwd(), env: { ...process.env, MONGODB_URI: "", DATA_DIR: path.join(process.cwd(), ".radlearn-tmp", "radlearn-data") } });
  const fixture = JSON.parse(await readFile("fixtures/synthetic/case.json", "utf8"));
  for (const original of fixture.findings) {
    const finding = { ...original, frameNumber: 1, phiReview: { pixels: true, audio: true, screen: true } };
    expect((await api(`/api/cases/${caseId}/findings`, finding)).status).toBe(200);
    const versions = await api(`/api/cases/${caseId}/findings/${finding.id}/versions`, undefined, "GET");
    expect(versions.status).toBe(200);
    const v = versions.data.at(-1);
    expect((await api(`/api/cases/${caseId}/findings/${finding.id}/approve`, { version: v.version, contentHash: v.contentHash })).status).toBe(200);
  }
  await page.goto(`/studio/cases/${caseId}`);
  await expect(page.getByText("Approved v1", { exact: true })).toHaveCount(2);
  const first = fixture.findings[0];
  const edit = await api(`/api/cases/${caseId}/findings/${first.id}/versions`, { expectedVersion: 1, patch: { description: "Expert edited synthetic finding" } });
  expect(edit.status).toBe(200);
  expect((await api(`/api/cases/${caseId}/findings/${first.id}/versions`, { expectedVersion: 1, patch: { description: "stale" } })).status).toBe(409);
  await page.reload();
  await expect(page.getByText("Needs review", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Approved v1", { exact: true })).toHaveCount(1);
  const eligible = await api(`/api/cases/${caseId}/findings`, undefined, "GET");
  expect(eligible.data.map((f: { id: string }) => f.id)).toEqual([fixture.findings[1].id]);
  const pack = await api(`/api/cases/${caseId}/live-teaching-pack`, undefined, "GET");
  expect(JSON.stringify(pack.data)).toContain(fixture.findings[1].label);
  expect(JSON.stringify(pack.data)).not.toContain(first.label);
  expect(JSON.stringify(pack.data)).not.toContain("Expert edited synthetic finding");
});
