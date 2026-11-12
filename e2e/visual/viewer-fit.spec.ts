import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The shared viewer shell fits its screen. Three regressions from a real
// device pass, on both /viewer and /viewer/local:
//  - desktop 1440: the toolbar's right edge was cut off (Keyboard & mouse
//    sat past the screen with no hint) — now the row goes dense and fits;
//  - phone: the bottom toolbar seemed to end at the layers icon — now the cut
//    edge shows a chevron that pages through to the last control;
//  - phone: ~120 px of footer links under the image — now one line (the
//    diagnostic-use notice) while a study is open.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

async function open(page: Page, route: string) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto(route);
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
}

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Viewer tools" });

for (const route of ["/viewer", "/viewer/local"]) {
  test.describe(`${route} at 1440`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("the whole toolbar is on screen, no hidden scroll", async ({ page }) => {
      await open(page, route);
      const fit = await toolbar(page).evaluate((row) => {
        const scroller = row.parentElement!;
        const box = scroller.getBoundingClientRect();
        const buttons = [...row.querySelectorAll("button")];
        const last = buttons[buttons.length - 1]!.getBoundingClientRect();
        return { overflow: scroller.scrollWidth - scroller.clientWidth, lastRight: last.right, edge: box.right, vw: innerWidth };
      });
      expect(fit.overflow, "toolbar scroll overflow").toBeLessThanOrEqual(1);
      expect(fit.lastRight).toBeLessThanOrEqual(Math.min(fit.edge, fit.vw) + 0.5);
      await expect(page.getByRole("button", { name: /^Keyboard & mouse/ })).toBeInViewport({ ratio: 1 });
      await expect(page.getByTestId("toolbar-more-right")).toHaveCount(0);
    });
  });

  test.describe(`${route} on a phone`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("the toolbar says there is more and pages to its last control", async ({ page }) => {
      await open(page, route);
      const keyboard = page.getByRole("button", { name: /^Keyboard & mouse/ });
      await expect(keyboard).not.toBeInViewport({ ratio: 1 });
      await expect(page.getByTestId("toolbar-more-left")).toHaveCount(0);
      for (let i = 0; i < 10 && (await page.getByTestId("toolbar-more-right").count()); i++) {
        await page.getByTestId("toolbar-more-right").tap();
        await page.waitForTimeout(400);
      }
      await expect(page.getByTestId("toolbar-more-right")).toHaveCount(0);
      await expect(keyboard).toBeInViewport({ ratio: 1 });
      // And back.
      await expect(page.getByTestId("toolbar-more-left")).toBeVisible();
    });

    test("each page of the toolbar ends on whole controls: no half button beside the chevron", async ({ page }) => {
      await open(page, route);
      const sliver = () =>
        page.evaluate(() => {
          const more = document.querySelector('[data-testid="toolbar-more-right"]');
          const row = document.querySelector('[role="toolbar"][aria-label="Viewer tools"]');
          if (!more || !row) return null;
          const solid = more.parentElement!.getBoundingClientRect();
          const fade = more.parentElement!.previousElementSibling?.getBoundingClientRect() ?? null;
          const edge = fade ? fade.left : solid.left;
          return [...row.querySelectorAll("button")]
            .filter((b) => !b.closest('[role="radiogroup"]'))
            .map((b) => b.getBoundingClientRect())
            .filter((r) => r.width >= 2 && r.left < edge - 0.5 && r.right > edge + 0.5)
            .map((r) => [Math.round(r.left), Math.round(r.right), Math.round(edge)]);
        });
      for (let i = 0; i < 10 && (await page.getByTestId("toolbar-more-right").count()); i++) {
        expect(await sliver(), `page ${i}: a control straddles the edge`).toEqual([]);
        await page.getByTestId("toolbar-more-right").tap();
        await page.waitForTimeout(400);
      }
    });

    test("the footer is one line under the image, the notice still showing", async ({ page }) => {
      await open(page, route);
      const notice = page.getByTestId("diagnostic-notice");
      await expect(notice).toBeVisible();
      const footer = (await page.locator("footer").boundingBox())!;
      expect(footer.height, "footer height").toBeLessThanOrEqual(32);
      await expect(page.getByRole("navigation", { name: "FlowRad products" })).toBeHidden();
    });
  });
}

test("the phone landing keeps the product links", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/viewer");
  await expect(page.getByRole("navigation", { name: "FlowRad products" })).toBeVisible();
  await expect(page.getByTestId("diagnostic-notice")).toBeVisible();
  await context.close();
});
