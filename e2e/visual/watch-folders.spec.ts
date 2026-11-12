import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Watched folders (Chrome / Edge; ported from FlowRad Viewer). The browser's
// folder picker can't be driven headless, so showDirectoryPicker is stubbed
// to return a real directory handle from the origin-private file system
// (OPFS). Synthetic DICOM files are copied into it, the folder is checked,
// the new study is listed without patient details, and it opens in the viewer.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

test("watched folder: a study copied in is listed and opens", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    window.localStorage.setItem("radlearn-cookie-ack", "1");
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle("Incoming studies", { create: true });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");

  // Chromium has directory handles: the landing offers watched folders.
  await page.getByRole("button", { name: /^Watched folders/ }).click();
  const dialog = page.getByRole("dialog", { name: "Watched folders" });
  await expect(dialog).toContainText("No folder is watched");
  await dialog.getByRole("button", { name: "Watch a folder…" }).click();
  await expect(dialog).toContainText("Incoming studies");
  await expect(dialog).toContainText(/Watching/);

  // A study arrives: 12 synthetic CT slices copied into the folder.
  const files = fs.readdirSync(DIR!).sort().slice(0, 12).map((f) => ({ name: f, bytes: [...fs.readFileSync(path.join(DIR!, f))] }));
  await page.evaluate(async (list) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("Incoming studies");
    for (const f of list) {
      const w = await (await dir.getFileHandle(f.name, { create: true })).createWritable();
      await w.write(new Uint8Array(f.bytes));
      await w.close();
    }
  }, files);

  // Files are read once they have stopped changing (two checks, 3 s old).
  await page.waitForTimeout(3500);
  const check = dialog.getByRole("button", { name: "Check this folder now" });
  await check.click();
  await page.waitForTimeout(400);
  await check.click();
  await expect(dialog).toContainText("CI TEST CT (SYNTHETIC)", { timeout: 15_000 });
  await expect(dialog).toContainText("12 images");
  await expect(dialog).not.toContainText("TEST^CT", { timeout: 1 }); // no patient name in the summary

  // Open it: the viewer reads the folder's files like any local folder.
  await dialog.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/1 series · 12 images/)).toBeVisible();

  // The side panel offers the folders again while reading.
  await expect(page.getByRole("button", { name: /^Watched folders/ })).toBeVisible();
  expect(errors).toEqual([]);
});
