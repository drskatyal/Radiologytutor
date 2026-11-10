import { expect, test, type Page } from "@playwright/test";

// RadLearn's case viewer (/case/[id]?mode=view) on the shared ViewerFrame,
// against the stand-in archive (e2e/support/mockArchive.mjs: Orthanc REST +
// the bench DICOMweb origin, one 60-slice CT series in `case-e2e-archive`).
// Pixel reads are gated on a session (lib/studyAccess), so each test signs in
// through the demo route first, as a student would arrive.

const SERIES = "1.2.826.0.1.3680043.8.498.20000000000000000000000001";

async function open(page: Page, query = "") {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  const signIn = await page.request.post("/api/auth/demo", { data: {} });
  expect(signIn.ok(), "demo sign-in").toBeTruthy();
  await page.goto(`/case/case-e2e-archive?mode=view${query}`);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
}

const slice = (page: Page) => page.getByRole("slider", { name: "Slice" }).first();

test.describe("case viewer at 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an archive case opens in the shared frame with the teaching tool set", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("heading", { name: "E2E archive CT" })).toBeVisible();
    await expect(slice(page)).toHaveAttribute("aria-valuetext", "Slice 31 of 60");
    await expect(page.getByText(/W 400\s+L 40\b/).first()).toBeVisible();
    // The teaching set: no free-viewer extras, and nothing from the local-files UI.
    await expect(page.getByRole("button", { name: /^Export images/ })).toHaveCount(0);
    await expect(page.getByText("Open other files")).toHaveCount(0);
    await expect(page.getByText("Your images never leave your computer.")).toHaveCount(0);
    await expect(page.getByText("Keep this study?")).toHaveCount(0);
    // One series: nothing to pick, so no series panel (as before the move).
    await expect(page.getByText("Local study")).toHaveCount(0);
    const canvas = (await page.locator("canvas").first().boundingBox())!;
    expect(canvas.x).toBeLessThan(2);
    expect(canvas.width).toBeGreaterThan(1400);
    // The toolbar keeps its Full screen button (the stage is shared with it).
    await page.getByRole("button", { name: /^Full screen/ }).click();
    await expect(page.getByTestId("local-stage")).toHaveAttribute("data-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("local-stage")).not.toHaveAttribute("data-expanded", "true");
  });

  test("a view link opens on its image and window, and View link copies the view back", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, `&series=${SERIES}&im=12&ww=1500&wc=-600`);
    await expect(slice(page)).toHaveAttribute("aria-valuetext", "Slice 12 of 60");
    await expect(page.getByText(/W 1500\s+L [−-]600/).first()).toBeVisible();
    await page.getByRole("button", { name: "View link" }).click();
    await expect(page.getByText("View link copied")).toBeVisible();
    const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
    expect(copied.pathname).toBe("/case/case-e2e-archive");
    expect(copied.searchParams.get("series")).toBe(SERIES);
    expect(copied.searchParams.get("im")).toBe("12");
    expect(copied.searchParams.get("ww")).toBe("1500");
    expect(copied.searchParams.get("wc")).toBe("-600");
  });
});

test.describe("case viewer on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the image sits right under the case header, the toolbar pages to its end", async ({ page }) => {
    await open(page);
    const header = (await page.locator("header").first().boundingBox())!;
    const canvas = (await page.locator("canvas").first().boundingBox())!;
    expect(canvas.y - (header.y + header.height)).toBeLessThan(4);
    await expect(page.getByTestId("toolbar-more-right")).toBeVisible();
  });
});
