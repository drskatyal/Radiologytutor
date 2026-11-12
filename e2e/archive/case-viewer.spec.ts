import { expect, test, type Page } from "@playwright/test";

// RadLearn's case viewer (/case/[id]?mode=view) on the shared ViewerFrame,
// against the stand-in archive (e2e/support/mockArchive.mjs: Orthanc REST +
// the bench DICOMweb origin, one 60-slice CT series in `case-e2e-archive`).
// Pixel reads are gated on a session (lib/studyAccess): the suite signs in once
// (e2e/support/archiveSignIn.ts) and every test starts with that session.

const SERIES = "1.2.826.0.1.3680043.8.498.20000000000000000000000001";

async function open(page: Page, query = "") {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto(`/case/case-e2e-archive?mode=view${query}`);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
}

const slice = (page: Page) => page.getByRole("slider", { name: "Slice" }).first();

/** A desktop with a second monitor (Window Management API), as a reviewer's desk has. */
async function twoScreens(page: Page) {
  await page.addInitScript(() => Object.defineProperty(window.screen, "isExtended", { get: () => true }));
}

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
    await expect(page.getByText("View link copied").first()).toBeVisible();
    const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
    expect(copied.pathname).toBe("/case/case-e2e-archive");
    expect(copied.searchParams.get("series")).toBe(SERIES);
    expect(copied.searchParams.get("im")).toBe("12");
    expect(copied.searchParams.get("ww")).toBe("1500");
    expect(copied.searchParams.get("wc")).toBe("-600");
  });
});

test.describe("case viewer at 1440, more", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the toolbar carries the hanging layouts (the header picker's old job)", async ({ page }) => {
    await open(page);
    const layout = page.getByTestId("toolbar-layout");
    await expect(layout).toHaveAccessibleName("Layout, Single");
    await layout.click();
    await page.getByRole("menuitemradio", { name: /Side by side/ }).click();
    await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(2, { timeout: 30_000 });
    await expect(layout).toHaveAccessibleName("Layout, Side by side");
    await layout.click();
    await page.getByRole("menuitemradio", { name: /Single/ }).click();
    await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(1);
  });

  test("on a two-screen desktop the image sits right under the header, dark: no light pop-out strip", async ({ page }) => {
    await twoScreens(page);
    await open(page);
    await expect(page.getByRole("button", { name: /Pop out to new window/ })).toHaveCount(0);
    const header = (await page.locator("header").first().boundingBox())!;
    const canvas = (await page.locator("canvas").first().boundingBox())!;
    expect(canvas.y - (header.y + header.height)).toBeLessThan(4);
    const bar = page.getByRole("toolbar", { name: "Viewer tools" });
    expect(await bar.evaluate((row) => getComputedStyle(row.parentElement!.parentElement!).backgroundColor)).toBe("rgb(0, 0, 0)");
  });

  test("signed out: a sign-in prompt, back to this view, and no image requests", async ({ browser }) => {
    // Not the suite's stored session: a visitor who never signed in.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    const archive: number[] = [];
    page.on("response", (res) => {
      if (res.url().includes("/api/dicomweb")) archive.push(res.status());
    });
    await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
    await page.goto(`/case/case-e2e-archive?mode=view&series=${SERIES}&im=12`);
    const prompt = page.getByTestId("case-sign-in");
    await expect(prompt.getByRole("heading", { name: "Sign in to view this study" })).toBeVisible();
    const href = await prompt.getByRole("link", { name: "Sign in" }).getAttribute("href");
    expect(decodeURIComponent(href!.split("next=")[1]!)).toBe(`/case/case-e2e-archive?mode=view&series=${SERIES}&im=12`);
    await expect(page.getByText("This series could not be displayed.")).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(archive, "no archive requests while signed out").toEqual([]);
    await context.close();
  });
});

test.describe("case viewer, Nov 11 review", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a reader opens on the case's first finding, not its last", async ({ page }) => {
    // case-e2e-teach: finding 1 at slice 14, finding 2 at slice 44.
    await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
    await page.goto("/case/case-e2e-teach?mode=view");
    await expect(page.getByRole("slider", { name: "Slice" }).first()).toHaveAttribute("aria-valuetext", "Slice 15 of 60", { timeout: 30_000 });
  });

  test("signed out on a case with findings: nothing protected is fetched (no prewarm, no CDN manifest)", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    const protectedRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/dicomweb") || url.includes("/api/dicom-cdn")) protectedRequests.push(new URL(url).pathname);
    });
    await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
    await page.goto("/case/case-e2e-teach?mode=view");
    await expect(page.getByTestId("case-sign-in")).toBeVisible();
    await page.waitForTimeout(2000);
    expect(protectedRequests).toEqual([]);
    await context.close();
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
