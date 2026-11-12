import { expect, test, type Page } from "@playwright/test";

// The student session (/case/[id], teach) on the shared ViewerFrame, against
// the stand-in archive (e2e/support/mockArchive.mjs): `case-e2e-teach` has two
// authored findings on the mock series — slice 14 at W 1500 / L −600, and
// slice 44 at W 400 / L 40. The session drives the frame's panes through its
// own handle refs (lib/teachingLayer bindControls), so these landings are the
// seam working end to end. No tutor (no Gemini key): the header's finding
// controls drive the tour.

async function open(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/case/case-e2e-teach");
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
}

const slices = (page: Page) => page.getByRole("slider", { name: "Slice" });

test.use({ viewport: { width: 1440, height: 900 } });

test("the session seats the first finding and the tour lands each one, with its overlay on the image", async ({ page }) => {
  await open(page);
  await expect(slices(page).first()).toHaveAttribute("aria-valuetext", "Slice 15 of 60");
  await expect(page.getByText(/W 1500\s+L [−-]600/).first()).toBeVisible();

  await page.getByRole("button", { name: "Next finding" }).click();
  await expect(slices(page).first()).toHaveAttribute("aria-valuetext", "Slice 45 of 60");
  await expect(page.getByText(/W 400\s+L 40\b/).first()).toBeVisible();
  // The tutor's card for the finding is drawn over the image (the layer's overlay).
  const card = page.getByText("E2E finding 2", { exact: true }).first();
  await expect(card).toBeVisible();
  const canvas = (await page.locator("canvas").first().boundingBox())!;
  const box = (await card.boundingBox())!;
  expect(box.y).toBeGreaterThan(canvas.y);
  expect(box.y + box.height).toBeLessThan(canvas.y + canvas.height);

  // The finding-marker hook covers the ink ring as well as the static marker.
  await expect(page.locator('[data-testid="finding-marker"][data-visible]').first()).toBeAttached();

  await page.getByRole("button", { name: "Previous finding" }).click();
  await expect(slices(page).first()).toHaveAttribute("aria-valuetext", "Slice 15 of 60");
});

test("compare opens a second pane beside the first with one toolbar, and closes back to one", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Open compare" }).click();
  await expect(slices(page)).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByRole("toolbar", { name: "Viewer tools" })).toHaveCount(1);
  await expect(slices(page).first()).toHaveAttribute("aria-valuetext", "Slice 15 of 60");
  await page.getByRole("button", { name: "Close compare" }).click();
  await expect(slices(page)).toHaveCount(1);
  await expect(slices(page).first()).toHaveAttribute("aria-valuetext", "Slice 15 of 60");
});

test("full screen keeps the microphone reachable", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /^Full screen/ }).click();
  const stage = page.getByTestId("local-stage");
  await expect(stage).toHaveAttribute("data-expanded", "true");
  await expect(stage.getByRole("button", { name: "Hold to ask" })).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(stage).not.toHaveAttribute("data-expanded", "true");
});

test("on a two-screen desktop there is no light pop-out strip over the session's image", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window.screen, "isExtended", { get: () => true }));
  await open(page);
  await expect(page.getByRole("button", { name: /Pop out to new window/ })).toHaveCount(0);
});

test.describe("phone compare", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the finding card stays inside its stacked pane, clear of the readouts and the pane badge", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Next finding" }).click();
    await expect(slices(page).first()).toHaveAttribute("aria-valuetext", "Slice 45 of 60");
    // The finding's card is up (full size in the tall single pane)…
    const card = page.getByTestId("sketch-card");
    await expect(card).toHaveAttribute("data-seated", "true");
    // …then compare stacks a second pane under it and the card must re-seat.
    await page.getByRole("button", { name: "Open compare" }).click();
    await expect(slices(page)).toHaveCount(2, { timeout: 30_000 });
    await expect(card).toHaveAttribute("data-seated", "true");
    await page.waitForTimeout(1200);
    const fit = await card.evaluate((el) => {
      const r = (e: Element) => e.getBoundingClientRect();
      const c = r(el);
      const pane = el.closest('[data-testid="viewer-pane"]')!;
      const p = r(pane);
      const chrome = [...pane.querySelectorAll(".imaging-readout, [data-imaging-chrome]")]
        .filter((z) => r(z).width > 0)
        .filter((z) => {
          const q = r(z);
          return c.left < q.right && q.left < c.right && c.top < q.bottom && q.top < c.bottom;
        })
        .map((z) => (z.textContent || "badge").trim());
      return {
        inside: c.left >= p.left && c.right <= p.right && c.top >= p.top && c.bottom <= p.bottom,
        clipped: el.scrollHeight > el.clientHeight + 1,
        covers: chrome,
      };
    });
    expect(fit).toEqual({ inside: true, clipped: false, covers: [] });
  });
});
