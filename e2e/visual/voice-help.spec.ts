import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Free viewer: the voice commands are listed where a reader finds them — a
// toolbar button next to the mic, and `?` (on the Voice commands tab of the
// help sheet). Nothing is recorded: the list is static. Synthetic CT only.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

async function open(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/viewer");
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
}

test("the voice list button opens every voice command, grouped", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.getByRole("button", { name: "Voice commands list" }).click();
  const dialog = page.getByRole("dialog", { name: "Voice commands" });
  await expect(dialog).toBeVisible();
  const list = dialog.getByTestId("voice-commands");
  for (const phrase of ["lung window", "next series", "zoom in", "reset view", "stop listening"]) {
    await expect(list.getByText(phrase, { exact: true })).toBeVisible();
  }
  for (const group of ["Navigate", "Tools", "Window presets", "MPR and 3D"]) {
    await expect(list.getByRole("heading", { name: group })).toBeVisible();
  }
  await expect(dialog.getByRole("button", { name: "Turn voice on" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("? opens the help sheet; its Voice commands tab lists the phrases", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.locator("canvas").first().click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("Shift+?");
  const dialog = page.getByRole("dialog", { name: "Viewer shortcuts" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Voice commands" }).click();
  await expect(page.getByRole("dialog", { name: "Voice commands" }).getByText("bone window", { exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "Voice commands" }).getByRole("tab", { name: "Keyboard & mouse" }).click();
  await expect(page.getByRole("dialog", { name: "Viewer shortcuts" })).toBeVisible();
});
