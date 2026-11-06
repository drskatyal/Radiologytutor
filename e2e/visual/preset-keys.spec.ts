import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Free viewer: number keys apply the window presets (as on the desktop viewer)
// and every preset row shows its key. Data: the synthetic CT (TEST_CT_DIR).

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

async function open(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/viewer");
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
}

const readout = (page: Page) => page.locator("body").innerText();

test("number keys 1, 2, 3, 4 apply lung, bone, brain, abdomen; 0 is the series default", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.locator("canvas").first().click({ position: { x: 40, y: 40 } });

  const expected: Array<[string, RegExp]> = [
    ["1", /W 1500 L [-−]600/],
    ["2", /W 2500 L 480/],
    ["3", /W 80 L 40/],
    ["4", /W 400 L 60/],
  ];
  for (const [key, line] of expected) {
    await page.keyboard.press(key);
    await expect.poll(() => readout(page), { message: `key ${key}` }).toMatch(line);
  }
  // The tool did not change: digits are presets, not tools.
  await expect(page.getByRole("button", { name: /Window presets, Abdomen/ })).toBeVisible();
  await page.keyboard.press("0");
  await expect(page.getByRole("button", { name: /Window presets, Default/ })).toBeVisible();
});

test("the preset menu shows each preset's key", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.getByRole("button", { name: /^Window presets/ }).click();
  const lung = page.getByRole("menuitemradio", { name: /^Lung/ });
  await expect(lung).toBeVisible();
  await expect(lung).toContainText("1");
  await expect(page.getByRole("menuitemradio", { name: /^Bone/ })).toContainText("2");
  await expect(page.getByRole("menuitemradio", { name: /^Series default/ })).toContainText("0");
});
