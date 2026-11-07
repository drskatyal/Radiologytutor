import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Text boxes on the free viewer (ported from FlowRad Viewer): click to place
// and type, saved in this browser per series and put back on the same image
// when the study is opened again, shown only on their own image, Delete
// removes, and "Save image with annotations" downloads a PNG with the box
// burned in. Synthetic CT only.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

const files = () => fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));

async function openStudy(page: Page) {
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files());
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
}

const boxes = (page: Page) => page.locator("[data-testid=web-text-boxes] [data-text-box]");
const image = (page: Page) => page.locator('[role="img"][aria-label^="DICOM viewer"]').first();

test("text boxes: place, persist across reopening, per image, delete, save annotated PNG", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await openStudy(page);
  const box = (await image(page).boundingBox())!;

  // Place and type.
  const tool = page.getByRole("button", { name: "Text box (saved in this browser)" });
  await tool.click();
  await expect(tool).toHaveAttribute("aria-pressed", "true");
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
  const editor = page.getByRole("textbox", { name: "Text box" });
  await expect(editor).toBeFocused();
  await editor.fill("Nodule 8 mm, follow up");
  await editor.press("Control+Enter");
  await expect(boxes(page)).toHaveCount(1);
  await expect(boxes(page).first()).toContainText("Nodule 8 mm");

  // Only on its own image: scroll away and back.
  await image(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(boxes(page)).toHaveCount(0);
  await page.keyboard.press("ArrowUp");
  await expect(boxes(page)).toHaveCount(1);

  // Save image with annotations: a PNG named without patient details.
  await page.getByRole("button", { name: "Save image with annotations (PNG)" }).click();
  const dialog = page.getByRole("dialog", { name: "Save the image with annotations" });
  await expect(dialog).toContainText("burned into the exported pixels");
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Save PNG" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^ct-annotated-[a-z0-9]+\.png$/);
  const png = fs.readFileSync((await download.path())!);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.length).toBeGreaterThan(5_000);

  // Saved in this browser: close the study, open the same files, the box is back.
  await page.waitForTimeout(700); // the save is debounced (400 ms)
  await page.getByRole("button", { name: "Close study" }).click();
  await openStudy(page);
  await expect(boxes(page)).toHaveCount(1, { timeout: 10_000 });
  await expect(boxes(page).first()).toContainText("Nodule 8 mm");

  // Select and delete.
  const tool2 = page.getByRole("button", { name: "Text box (saved in this browser)" });
  await tool2.click();
  const at = (await boxes(page).first().locator("rect").boundingBox())!;
  await page.mouse.click(at.x + 10, at.y + 6);
  await page.keyboard.press("Delete");
  await expect(boxes(page)).toHaveCount(0);

  // Another tool turns the text-box tool off.
  await page.getByRole("button", { name: /^Window \/ level/ }).first().click();
  await expect(tool2).toHaveAttribute("aria-pressed", "false");
  expect(errors).toEqual([]);
});
