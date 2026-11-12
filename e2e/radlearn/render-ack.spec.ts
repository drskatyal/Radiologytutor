import { expect, test } from "@playwright/test";
import { authorCaptureCase, localCaptures, localJournal, snapshot } from "../support/captureFixture";

test("P0-3/T10 delayed real renders timestamp the displayed identity; restore waits, acknowledges or times out", async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    // Delay the real renderer's animation frame; do not forge IMAGE_RENDERED.
    window.requestAnimationFrame = callback => request(time => {
      const delay = Number(sessionStorage.getItem("synthetic-render-delay") || 0);
      if (delay) setTimeout(() => callback(performance.now()), delay); else callback(time);
    });
  });
  await authorCaptureCase(page);
  const original = await snapshot(page);
  await page.getByRole("button", { name: "Start recording", exact: true }).first().click();
  await expect.poll(async () => (await localCaptures(page))[0]?.manifest.chunks.some(c => c.stream === "audio"), { timeout: 20000 }).toBe(true);
  const id = (await localCaptures(page))[0].manifest.sessionId;
  await page.evaluate(() => sessionStorage.setItem("synthetic-render-delay", "800"));
  const before = await page.evaluate(() => performance.now());
  const slider = page.getByRole("slider", { name: "Slice", exact: true }).first();
  await slider.focus();
  const openingValue = Number(await slider.getAttribute("aria-valuenow") ?? await slider.inputValue());
  await slider.press(openingValue <= 1 ? "End" : "Home");
  await expect.poll(async () => (await snapshot(page)).sopUID, { timeout: 10000 }).not.toBe(original.sopUID);
  const changed = await snapshot(page);
  const journal = await localJournal(page, id);
  const changedRender = journal.find(e => e.kind === "render" && e.snapshot?.sopUID === changed.sopUID);
  expect(changedRender).toBeTruthy();
  const input = journal.find(e => e.kind === "input" && (e.payload?.event as { type?: string })?.type === "slice");
  expect(input).toBeTruthy();
  expect(changedRender!.t).toBeGreaterThan(input!.t);
  expect(await page.evaluate(() => performance.now()) - before).toBeGreaterThanOrEqual(750);
  await page.evaluate(() => sessionStorage.removeItem("synthetic-render-delay"));
  await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  const restore = page.getByRole("button", { name: "Restore captured view", exact: true });
  await expect(restore).toBeEnabled();
  await page.evaluate(() => sessionStorage.setItem("synthetic-render-delay", "800"));
  await restore.click();
  await expect(page.getByTestId("capture-status")).toContainText("Waiting for the recorded image to render");
  await expect(page.getByTestId("capture-status")).toContainText("Recorded image rendered and confirmed", { timeout: 10000 });
  expect((await snapshot(page)).sopUID).toBe(original.sopUID);
  expect((await snapshot(page)).frame).toBe(original.frame);
  await page.evaluate(() => sessionStorage.setItem("synthetic-render-delay", "6500"));
  await restore.click();
  await expect(page.getByTestId("capture-status")).toContainText("Recorded image was not confirmed", { timeout: 10000 });
});
