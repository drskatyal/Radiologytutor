import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// PET / CT fusion on the free viewer (desktop parity, Ctrl/⌘+Shift+F): the
// CT with a colour PET overlay in three linked planes and a PET MIP, PET in
// SUVbw from the dose, timing and weight tags. The synthetic study of
// scripts/make-test-petct.py has SUVbw 8.0 at its hottest voxel, so the
// readout must say so. A CT-only study offers no fusion.

const DIR = process.env.TEST_PETCT_DIR;
const CT_ONLY = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_PETCT_DIR is not set (scripts/make-test-petct.py)");

const filesOf = (dir: string) => fs.readdirSync(dir).map((f) => path.join(dir, f));
const workspace = (page: Page) => page.getByTestId("fusion-workspace");

async function open(page: Page, dir: string) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(filesOf(dir));
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);
}

/** Mean colour saturation of a pane (max − min channel, 0–255): about 0 for grey CT, higher with the PET overlay. */
async function tint(page: Page, label: RegExp): Promise<number> {
  const pane = workspace(page).getByRole("img", { name: label });
  return pane.evaluate((el) => {
    const canvas = el.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) return -1;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext("2d")!;
    ctx.drawImage(canvas, 0, 0);
    const d = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += Math.max(d[i]!, d[i + 1]!, d[i + 2]!) - Math.min(d[i]!, d[i + 1]!, d[i + 2]!);
    return sum / (d.length / 4);
  });
}

test("fusion: CT + PET overlay in SUVbw, peak 8.0, colour map and opacity, back to the stack", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await open(page, DIR!);

  await page.getByRole("button", { name: "PET / CT fusion" }).click();
  await expect(workspace(page)).toBeVisible();
  await expect(workspace(page)).toHaveAttribute("data-loaded", "true", { timeout: 60_000 });
  await expect(workspace(page)).toHaveAttribute("data-suv", "suv");
  const peak = Number(await workspace(page).getAttribute("data-peak"));
  expect(peak).toBeGreaterThan(7.9);
  expect(peak).toBeLessThan(8.1);
  await expect(page.getByTestId("fusion-units")).toContainText("PET in SUVbw (body weight)");
  await expect(page.getByTestId("fusion-units")).toContainText("Peak SUVbw 8.0");
  await expect(workspace(page).getByRole("img", { name: /^(Axial · fused|Coronal · fused|Sagittal · fused|PET MIP):/ })).toHaveCount(4);
  await page.waitForTimeout(500);

  // The overlay is in colour on the fused planes; the MIP is grey.
  const fused = await tint(page, /^Coronal · fused/);
  expect(fused).toBeGreaterThan(4);
  expect(await tint(page, /^PET MIP/)).toBeLessThan(1);

  // Opacity 0 leaves the CT untinted.
  const opacity = workspace(page).getByRole("slider", { name: "PET opacity" });
  await opacity.fill("0");
  await page.waitForTimeout(300);
  expect(await tint(page, /^Coronal · fused/)).toBeLessThan(1);
  await opacity.fill("0.6");
  await workspace(page).getByLabel("Colour").selectOption("Inferno (matplotlib)");
  await page.waitForTimeout(300);
  const hot = await tint(page, /^Coronal · fused/);
  expect(hot).toBeGreaterThan(1); // still tinted…
  expect(Math.abs(hot - fused)).toBeGreaterThan(0.5); // …in a different colour map
  await expect(workspace(page).getByRole("slider", { name: "SUV max" })).toHaveValue("6");

  // Back to images: the stack is there again.
  await workspace(page).getByRole("button", { name: "Back to images" }).click();
  await expect(workspace(page)).toBeHidden();
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible();

  // Ctrl+Shift+F and the right-click menu open it too; Esc closes.
  await page.locator('[role="img"][aria-label^="DICOM viewer"]').first().focus();
  await page.keyboard.press("Control+Shift+F");
  await expect(workspace(page)).toBeVisible();
  await workspace(page).getByRole("button", { name: "Back to images" }).focus();
  await page.keyboard.press("Escape");
  await expect(workspace(page)).toBeHidden();
  const box = (await page.locator("canvas").first().boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2, { button: "right" });
  await page.getByRole("menu", { name: "Image" }).getByRole("menuitem", { name: /^Reformat/ }).hover();
  await page.getByRole("menuitemradio", { name: /^PET \/ CT fusion/ }).press("Enter");
  await expect(workspace(page)).toBeVisible();
  await expect(workspace(page)).toHaveAttribute("data-suv", "suv");

  expect(errors).toEqual([]);
});

test("fusion: a CT-only study offers none", async ({ page }) => {
  test.skip(!CT_ONLY, "TEST_CT_DIR is not set");
  await open(page, CT_ONLY!);
  await expect(page.getByRole("button", { name: "Oblique, slab and curved MPR" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PET / CT fusion" })).toHaveCount(0);
});
