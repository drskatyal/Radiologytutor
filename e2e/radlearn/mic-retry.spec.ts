import { expect, test } from "@playwright/test";
import { authorCaptureCase, localCaptures, localJournal } from "../support/captureFixture";

test("T5 microphone denial shows an actionable error; a second take captures fake audio on a fresh clock", async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let first = true;
    navigator.mediaDevices.getUserMedia = constraints => {
      if (first) { first = false; return Promise.reject(new DOMException("Synthetic permission denial", "NotAllowedError")); }
      return open(constraints);
    };
  });
  await authorCaptureCase(page);
  await page.getByRole("button", { name: "Start recording", exact: true }).first().click();
  await expect(page.getByTestId("capture-status").getByRole("alert")).toContainText("Microphone unavailable");
  await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  await expect.poll(async () => (await localCaptures(page))[0]?.synced, { timeout: 20000 }).toBe(true);
  const first = (await localCaptures(page))[0];
  expect(first.manifest.chunks.some(c => c.stream === "audio")).toBe(false);
  await page.getByRole("button", { name: /^(Start recording|Record again)$/ }).first().click();
  await expect(page.getByTestId("capture-status")).toContainText("waiting for the first microphone sample");
  await expect.poll(async () => (await localCaptures(page)).find(c => c.manifest.sessionId !== first.manifest.sessionId)?.manifest.chunks.some(c => c.stream === "audio"), { timeout: 20000 }).toBe(true);
  await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  await expect.poll(async () => (await localCaptures(page)).filter(c => c.synced).length, { timeout: 20000 }).toBe(2);
  const second = (await localCaptures(page)).find(c => c.manifest.sessionId !== first.manifest.sessionId)!;
  expect(second.manifest.offsets.audio).toBeGreaterThanOrEqual(0);
  expect(second.manifest.offsets.audio).toBeLessThan(second.manifest.durationMs);
  const journal = await localJournal(page, second.manifest.sessionId);
  expect(journal.find(e => e.kind === "render")?.t).toBeLessThan(2000);
  expect(journal.some(e => e.payload?.reason === "microphone_unavailable")).toBe(false);
});
