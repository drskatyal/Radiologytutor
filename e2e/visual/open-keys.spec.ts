import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The desktop's open keys in the free viewer: Ctrl/⌘+O opens DICOM files and
// Ctrl/⌘+Shift+O a folder, on the landing and with a study open. The folder
// picker is the browser's own (File System Access) where it exists, so the
// test stands in for it and records the call. Synthetic CT only.

const CT = process.env.TEST_CT_DIR;

test("open keys: Ctrl+O opens files (landing and with a study open), Ctrl+Shift+O a folder", async ({ page }) => {
  test.skip(!CT, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    window.localStorage.setItem("radlearn-cookie-ack", "1");
    const w = window as unknown as { __folderPicks: number; showDirectoryPicker: () => Promise<never> };
    w.__folderPicks = 0;
    w.showDirectoryPicker = async () => {
      w.__folderPicks += 1;
      throw new DOMException("The user aborted a request.", "AbortError");
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await expect(page.getByRole("button", { name: "Choose a folder" })).toBeVisible();
  const files = fs.readdirSync(CT!).sort().slice(0, 12).map((f) => path.join(CT!, f));

  // Landing: Ctrl+O is the file picker, and what it picks opens.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Control+o")]);
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles(files);
  const slider = page.getByRole("slider", { name: "Slice" }).first();
  await expect(slider).toBeVisible({ timeout: 30_000 });

  // With a study open, from the image: still the file picker (nothing else fires).
  const image = page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
  await image.focus();
  const [again] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Control+o")]);
  await again.setFiles([]);
  await expect(slider).toBeVisible();

  // Ctrl+Shift+O: the folder picker (cancelled here: the study stays open).
  await image.focus();
  await page.keyboard.press("Control+Shift+O");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __folderPicks: number }).__folderPicks)).toBe(1);
  await expect(slider).toBeVisible();

  // The help sheet lists them.
  await image.focus();
  await page.keyboard.press("Shift+?");
  const help = page.getByRole("dialog");
  await expect(help.getByText("Open DICOM files")).toBeVisible();
  await expect(help.getByText("Open a folder")).toBeVisible();
  expect(errors).toEqual([]);
});
