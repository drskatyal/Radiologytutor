import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Current vs prior, as on the desktop: a study opened together with an earlier
// study of the same patient hangs side by side (the newest on the left), the
// prior registered from the superior ends and scrolling with the current.
// Another patient's study never hangs as a prior. Synthetic studies from
// scripts/make-test-prior.py: the prior covers 8 fewer images (20 mm) at the top.

const PRIOR = process.env.TEST_PRIOR_DIR;

const filesOf = (...folders: string[]) =>
  folders.flatMap((f) => fs.readdirSync(path.join(PRIOR!, f)).map((n) => path.join(PRIOR!, f, n)));

async function open(page: Page, files: string[]) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
}

const sliceText = (page: Page, pane: number) => page.getByRole("slider", { name: "Slice" }).nth(pane);

test("compare prior: the same patient's earlier study hangs beside the current, registered and linked", async ({ page }) => {
  test.skip(!PRIOR, "TEST_PRIOR_DIR is not set (scripts/make-test-prior.py)");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // The prior first: the protocol, not the drop order, decides the panes.
  await open(page, filesOf("prior", "current"));
  await expect(page.getByRole("radio", { name: "Side by side layout" })).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("hanging-label")).toHaveText("Current 2025-01-01 vs prior 2024-01-05");
  // The current (40 images, feet to head, 2.5 mm) on the left at its middle
  // (21: z −47.5). The prior (32 images, its top 20 mm lower) registered from the
  // superior ends: z −67.5, image 13, not its own middle (17).
  await expect(sliceText(page, 0)).toHaveAttribute("aria-valuetext", "Slice 21 of 40");
  await expect(sliceText(page, 1)).toHaveAttribute("aria-valuetext", "Slice 13 of 32", { timeout: 15_000 });

  // Scroll the current four images down: the prior follows, still level.
  await page.getByTestId("viewer-pane").first().click({ position: { x: 80, y: 80 } });
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowDown");
  await expect(sliceText(page, 0)).toHaveAttribute("aria-valuetext", "Slice 25 of 40");
  await expect(sliceText(page, 1)).toHaveAttribute("aria-valuetext", "Slice 17 of 32", { timeout: 10_000 });

  // Another layout: the protocol's label goes with it.
  await page.getByRole("radio", { name: "Single layout" }).click();
  await expect(page.getByTestId("hanging-label")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("compare prior: another patient's study does not hang as a prior", async ({ page }) => {
  test.skip(!PRIOR, "TEST_PRIOR_DIR is not set (scripts/make-test-prior.py)");
  test.setTimeout(120_000);
  await open(page, filesOf("other", "current"));
  await page.waitForTimeout(1500);
  await expect(page.getByRole("radio", { name: "Single layout" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(1);
  await expect(page.getByTestId("hanging-label")).toHaveCount(0);
});
