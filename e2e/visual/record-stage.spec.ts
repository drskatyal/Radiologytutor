import { expect, test, type Page } from "@playwright/test";

// The record/replay stage (components/record/RecordStage) on the shared
// ViewerFrame, at /record: the bundled sample MR (10 frames, served from
// /public — no archive). The recorder drives the viewer through its own
// handle (lib/teachingLayer bindControls) and hears every viewer event
// (onViewerEvent): record a short walk-through, then replay must start from
// the recorded opening slice and retrace to where the recording ended.

test.use({ viewport: { width: 1440, height: 900 } });

const sliceText = (page: Page) => page.getByRole("slider", { name: "Slice" }).first().getAttribute("aria-valuetext");

test("record a walk-through on the shared frame, then replay it from its first slice", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/record");
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  // The author's stage opens on Window / level, with full screen on its toolbar.
  await expect(page.getByRole("button", { name: /^Window \/ level/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^Full screen/ })).toBeVisible();
  await expect.poll(() => sliceText(page)).toBe("Slice 6 of 10");

  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByText("Rec", { exact: true })).toBeVisible();
  const canvas = (await page.locator("canvas").first().boundingBox())!;
  for (let i = 0; i < 5; i++) await page.mouse.move(canvas.x + canvas.width * (0.3 + i * 0.1), canvas.y + canvas.height * 0.5, { steps: 3 });
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(120);
  }
  await expect.poll(() => sliceText(page)).toBe("Slice 10 of 10");
  await page.getByRole("button", { name: "Stop recording" }).click();

  // The take: cursor and scroll events from the frame's viewer.
  const events = Number(await page.locator("dt", { hasText: "Events" }).locator("xpath=following-sibling::dd[1]").textContent());
  expect(events).toBeGreaterThanOrEqual(5);

  // Replay rewinds to the opening slice, then retraces to the last.
  await page.getByRole("button", { name: "Replay recording" }).click();
  await expect(page.getByText("Replaying")).toBeVisible();
  await expect.poll(() => sliceText(page), { timeout: 5_000 }).toBe("Slice 6 of 10");
  await expect.poll(() => sliceText(page), { timeout: 15_000 }).toBe("Slice 10 of 10");
  await expect(page.getByRole("button", { name: "Replay recording" })).toBeEnabled({ timeout: 15_000 });
});
