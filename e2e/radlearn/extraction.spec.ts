import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { authorCaptureCase, localCaptures, snapshot } from "../support/captureFixture";

test("M6 retained extraction commits exactly two drafts across a lost response and a later expert edit", async ({ page, browser }) => {
  test.setTimeout(120000);
  const { caseId, orgId } = await authorCaptureCase(page);
  await page.getByRole("button", { name: "Start recording", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Finish recording", exact: true })).toBeVisible();
  const slider = page.getByRole("slider", { name: "Slice", exact: true }).first();
  const canvas = page.locator("[data-viewer-snapshot] canvas").first();
  const expected = [];
  for (let i = 0; i < 2; i++) {
    const old = await snapshot(page);
    const oldIndex = Number(await slider.getAttribute("aria-valuenow") ?? await slider.inputValue());
    await slider.focus(); await slider.press(i === 0 ? "Home" : "ArrowRight");
    if (i > 0 || oldIndex > 1) await expect.poll(async () => `${(await snapshot(page)).sopUID}/${(await snapshot(page)).frame}`).not.toBe(`${old.sopUID}/${old.frame}`);
    expected.push(await snapshot(page));
    await canvas.click({ position: { x: 100, y: 100 } });
    await expect(page.getByTestId("pending-markers")).toContainText(`${i + 1} retained markers`);
  }
  await page.waitForTimeout(100); // a finite captured evidence window after the last marker
  await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  await expect.poll(async () => (await localCaptures(page))[0]?.synced, { timeout: 20000 }).toBe(true);
  const capture = (await localCaptures(page))[0];
  const base = `/api/cases/${caseId}/capture-sessions/${capture.manifest.sessionId}/extract`;
  const anonymous = await browser.newContext();
  expect((await anonymous.request.get(base)).status()).toBe(401);
  expect((await anonymous.request.post(base, { data: { action: "extract" } })).status()).toBe(401);
  await anonymous.close();
  expect((await page.request.post(base, { data: { action: "extract" } })).status()).toBe(422);
  await page.getByLabel("I reviewed the captured images, audio and viewport video and found no patient identifiers.").check();
  await page.getByRole("button", { name: "Save media review" }).click();
  await expect(page.getByText("Media PHI review recorded.")).toBeVisible();
  const rejected = await page.request.post(base, { data: { action: "extract", model: "client-selected", media: "unreviewed" } });
  expect(rejected.status()).toBe(400);
  const legacy = await page.request.post("/api/structure-session", { data: { caseId, track: { captureSessionId: capture.manifest.sessionId }, transcript: "CANARY_ANSWER" } });
  expect(legacy.status()).toBe(409);
  await promisify(execFile)(process.execPath, ["--import", "tsx", "e2e/support/extractionFixtureSetup.ts", orgId, caseId, capture.manifest.sessionId], { cwd: process.cwd(), env: { ...process.env, MONGODB_URI: "", DICOMWEB_BACKEND: "orthanc", ORTHANC_URL: "", DATA_DIR: path.join(process.cwd(), ".radlearn-tmp", "radlearn-data") } });
  const job = await (await page.request.get(base)).json();
  expect(job.status).toBe("ready"); expect(job.drafts).toHaveLength(2); expect(job.leaseToken).toBeUndefined();
  expect(job.drafts.map((d: { finding: { sopInstanceUID: string } }) => d.finding.sopInstanceUID)).toEqual(expected.map(s => s.sopUID));
  let lost = false;
  await page.route(`**${base}`, async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON().action === "commit" && !lost) {
      const committed = await route.fetch(); expect(committed.status()).toBe(200); lost = true;
      await route.abort("failed"); // server write happened; the browser never received it
    } else await route.continue();
  });
  const processButton = page.getByRole("button", { name: "Process and teach case", exact: true });
  await processButton.click();
  await expect.poll(() => lost).toBe(true); await expect(processButton).toBeEnabled();
  const saved = await (await page.request.get(`/api/cases/${caseId}`)).json();
  expect(saved.findings).toHaveLength(2);
  const edited = await page.request.post(`/api/cases/${caseId}/findings/${saved.findings[0].id}/versions`, { data: { expectedVersion: 1, patch: { label: "Later expert edit" } } });
  expect(edited.status()).toBe(200);
  await processButton.click();
  await expect(page.getByText("Draft findings ready — 2 candidates. Review the evidence before approval.")).toBeVisible();
  const final = await (await page.request.get(`/api/cases/${caseId}`)).json();
  expect(final.findings).toHaveLength(2); expect(final.findings[0].label).toBe("Later expert edit");
  expect(final.findings[0].currentVersion).toBe(2); expect(final.findingVersions).toHaveLength(3);
  const again = await (await page.request.get(base)).json();
  expect(again.id).toBe(job.id); expect(again.attempts).toBe(1); expect(again.status).toBe("committed"); expect(again.receipts).toHaveLength(2);
  expect(again.modelMetadata.responseModelVersion).toBe("local-synthetic-mock");
  await page.screenshot({ path: test.info().outputPath("extraction-committed.png"), fullPage: true });
});
