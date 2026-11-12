import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { authorReviewCase } from "../support/reviewFixture";

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

test("M7 keyboard review approves saved versions, invalidates edits and preserves a conflicting local draft", async ({ page }) => {
  test.setTimeout(120000);
  const { caseId } = await authorReviewCase(page);
  const first = page.getByTestId("finding-review-review-1"), second = page.getByTestId("finding-review-review-2");
  for (const card of [first, second]) {
    await expect(card.getByRole("button", { name: "Approve v1" })).toBeDisabled();
    await card.getByRole("textbox", { name: /^Label/ }).focus();
    await page.keyboard.press("Tab"); await expect(card.getByRole("textbox", { name: "Description", exact: true })).toBeFocused();
    expect((await card.getByRole("textbox", { name: "Description", exact: true }).boundingBox())!.y).toBeGreaterThanOrEqual(96);
    for (const label of ["Images contain no patient identifiers", "Audio contains no patient identifiers", "Screen recording contains no patient identifiers"]) {
      const checkbox = card.getByLabel(label);
      await checkbox.focus(); await page.keyboard.press("Space"); await expect(checkbox).toBeChecked();
      expect((await checkbox.boundingBox())!.y).toBeGreaterThanOrEqual(96);
    }
    await card.getByRole("button", { name: "Save new version" }).click();
    await expect(card.getByRole("button", { name: "Approve v2" })).toBeEnabled();
    await card.getByRole("button", { name: "Approve v2" }).focus(); await page.keyboard.press("Enter");
    await expect(card.getByText("Approved v2", { exact: true })).toBeVisible();
  }
  await first.getByRole("textbox", { name: /^Label/ }).fill("Expert UI correction");
  await expect(first.getByRole("button", { name: "Approve v2" })).toBeDisabled();
  await first.getByRole("button", { name: "Save new version" }).click();
  await expect(first.getByText("Needs review", { exact: true })).toBeVisible();
  await expect(second.getByText("Approved v2", { exact: true })).toBeVisible();
  await first.getByText("Version history (3)", { exact: true }).click();
  await first.getByText("Changes in v3", { exact: true }).click();
  await expect(first.locator("ins").filter({ hasText: "Expert UI correction" })).toBeVisible();
  const eligible = await page.request.get(`/api/cases/${caseId}/findings`);
  expect((await eligible.json()).map((f: { id: string }) => f.id)).toEqual(["review-2"]);
  const pack = await (await page.request.get(`/api/cases/${caseId}/live-teaching-pack`)).json();
  expect(JSON.stringify(pack)).toContain("Synthetic review finding 2"); expect(JSON.stringify(pack)).not.toContain("Expert UI correction");
  await first.getByRole("textbox", { name: /^Label/ }).fill("Unsaved local correction");
  page.once("dialog", async dialog => { expect(dialog.message()).toContain("unsaved changes"); await dialog.dismiss(); });
  await page.getByRole("tab", { name: "Sequence editor" }).click();
  await expect(first.getByRole("textbox", { name: /^Label/ })).toHaveValue("Unsaved local correction");
  expect((await page.request.post(`/api/cases/${caseId}/findings/review-1/versions`, { data: { expectedVersion: 3, patch: { label: "Concurrent expert version" } } })).status()).toBe(200);
  await first.getByRole("button", { name: "Save new version" }).click();
  await expect(first.getByRole("alert")).toContainText("Finding changed");
  await expect(first.getByRole("textbox", { name: /^Label/ })).toHaveValue("Unsaved local correction");
  await expect(first.getByRole("button", { name: "Approve v3" })).toBeDisabled();
  await first.getByRole("button", { name: "Discard edits and reload" }).click();
  await expect(first.getByRole("textbox", { name: /^Label/ })).toHaveValue("Concurrent expert version");
  await first.getByRole("textbox", { name: /^Label/ }).scrollIntoViewIfNeeded();
  await first.getByRole("textbox", { name: /^Label/ }).focus();
  await page.screenshot({ path: test.info().outputPath("approval-keyboard.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await first.getByRole("textbox", { name: /^Label/ }).scrollIntoViewIfNeeded();
  await expect(first.getByRole("textbox", { name: /^Label/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("approval-mobile.png") });
});
