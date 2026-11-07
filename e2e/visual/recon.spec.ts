import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Oblique, slab and curved MPR on the free viewer (ported from FlowRad
// Viewer): the workspace builds a volume from the open stack in the browser,
// shows three linked planes that redraw when the crosshair moves or a slab is
// chosen, switches to curved mode, and returns to the stack. Synthetic CT only.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

/** A cheap fingerprint of what a pane's canvas shows. */
const fingerprint = (pane: Locator) =>
  pane.locator("canvas").first().evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let lit = 0;
    for (let i = 0; i < d.length; i += 64) {
      sum = (sum + d[i]! * (i % 997)) % 1_000_000_007;
      if (d[i]! > 20) lit += 1;
    }
    return `${lit}:${sum}`;
  });

async function open(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(fs.readdirSync(DIR!).map((f) => path.join(DIR!, f)));
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
}

test("recon: three linked oblique planes, slab, curved mode, back to the stack", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await open(page);
  await page.getByRole("button", { name: "Oblique, slab and curved MPR" }).click();

  const axial = page.getByRole("img", { name: "Axial reconstruction" });
  const coronal = page.getByRole("img", { name: "Coronal reconstruction" });
  const sagittal = page.getByRole("img", { name: "Sagittal reconstruction" });
  for (const pane of [axial, coronal, sagittal]) await expect(pane).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Volume 512 × 512 × 60/)).toBeVisible();
  // Every plane draws anatomy.
  await expect.poll(async () => Number((await fingerprint(coronal)).split(":")[0])).toBeGreaterThan(50);

  // Moving the crosshair in the axial pane moves the other planes.
  const before = await fingerprint(coronal);
  const box = (await axial.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.35);
  await expect.poll(() => fingerprint(coronal)).not.toBe(before);

  // A MIP slab redraws the planes.
  const thin = await fingerprint(sagittal);
  await page.getByRole("combobox", { name: "Planes: slab mode" }).selectOption("mip");
  await expect.poll(() => fingerprint(sagittal)).not.toBe(thin);

  // Curved mode, then back to the stack.
  await page.getByRole("radio", { name: "Curved" }).click();
  await expect(page.getByRole("radio", { name: "Curved" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Images" }).click();
  await expect(axial).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
