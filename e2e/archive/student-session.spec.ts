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
  const signIn = await page.request.post("/api/auth/demo", { data: {} });
  expect(signIn.ok(), "demo sign-in").toBeTruthy();
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
  await expect(stage.getByRole("button", { name: "Open microphone" })).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(stage).not.toHaveAttribute("data-expanded", "true");
});
