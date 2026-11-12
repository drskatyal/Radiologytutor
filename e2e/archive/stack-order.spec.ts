import { expect, test, type Page } from "@playwright/test";

// Archive stacks scroll in anatomical order. The stand-in archive returns its
// 60-slice series in the scrambled order the staging archive returns the
// de-identified LIDC chest CT (lib/fixtures/lidcStackGeometry.json): z is
// index × 1.25 mm in true order, so Loc on the overlay must climb with the
// image number, and authored findings land on their own slices
// (case-e2e-teach: finding 1 at index 14 = Loc 17.5, finding 2 at 44 = Loc 55).

test.use({ viewport: { width: 1440, height: 900 } });

/** "Loc" of the first pane's overlay, in mm. */
async function loc(page: Page, pane = 0): Promise<number> {
  const text = await page.getByText(/Loc\s+[−-]?\d/).nth(pane).textContent();
  const m = /Loc\s+([−-]?[\d.]+)/.exec(text ?? "");
  return Number((m?.[1] ?? "NaN").replace("−", "-"));
}
const slice = (page: Page, i = 0) => page.getByRole("slider", { name: "Slice" }).nth(i);

async function openView(page: Page, path: string) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto(path);
  await expect(slice(page)).toBeVisible({ timeout: 30_000 });
}

test("the case viewer scrolls head to foot and opens on finding 1's own slice", async ({ page }) => {
  await openView(page, "/case/case-e2e-teach?mode=view");
  await expect(slice(page)).toHaveAttribute("aria-valuetext", "Slice 15 of 60");
  await expect.poll(() => loc(page)).toBe(17.5);
  // Scroll: Loc climbs 1.25 mm per image, never jumps (the archive order would).
  const seen = [await loc(page)];
  await page.locator("canvas").first().click({ position: { x: 40, y: 40 } });
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => loc(page)).not.toBe(seen[seen.length - 1]);
    seen.push(await loc(page));
  }
  // The overlay prints one decimal: 1.25 mm steps read 1.3 / 1.2. Every step is
  // one slice, all the same way (the archive order jumps tens of mm).
  const steps = seen.slice(1).map((v, i) => v - seen[i]!);
  for (const step of steps) expect(Math.abs(step)).toBeGreaterThan(1.1), expect(Math.abs(step)).toBeLessThan(1.4);
  expect(new Set(steps.map(Math.sign)).size).toBe(1);
});

test("the session lands finding 2 on its slice, ring and card on it, and compare leaves it there", async ({ page }) => {
  await openView(page, "/case/case-e2e-teach");
  await expect.poll(() => loc(page)).toBe(17.5);
  await page.getByRole("button", { name: "Next finding" }).click();
  await expect(slice(page)).toHaveAttribute("aria-valuetext", "Slice 45 of 60");
  await expect.poll(() => loc(page)).toBe(55);
  await expect(page.getByTestId("sketch-card")).toHaveAttribute("data-seated", "true");
  await expect(page.locator('[data-testid="finding-marker"][data-visible]').first()).toBeAttached();
  await page.getByRole("button", { name: "Open compare" }).click();
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(2, { timeout: 30_000 });
  // Both panes are the same anatomical stack: the compare pane's Loc follows its image number.
  await expect.poll(() => loc(page)).toBe(55);
  const compareIndex = Number(/Slice (\d+)/.exec((await slice(page, 1).getAttribute("aria-valuetext")) ?? "")?.[1]);
  await expect.poll(() => loc(page, 1)).toBe((compareIndex - 1) * 1.25);
});
