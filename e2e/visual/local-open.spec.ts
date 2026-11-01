import { expect, test, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// P0 regression: on /viewer/local "Choose a folder" and "Choose files" did
// nothing on short laptop windows (Windows Chrome, ~1366×600): the cookie
// notice's full-width fixed layer sat over them and took the click. These run
// WITH the notice showing (a first visit), at the sizes that broke, and
// assert a real mouse click opens the file chooser; then a drag-and-drop of a
// study opens it.

const SIZES = [
  { width: 1280, height: 577 },
  { width: 1366, height: 600 },
  { width: 1536, height: 650 },
  { width: 1440, height: 900 },
  { width: 390, height: 664 },
];

async function clickOpensChooser(page: Page, name: string) {
  const button = page.getByRole("button", { name });
  // Where a reader would have it: mid-screen (a fixed notice may cover the
  // very bottom edge on a phone, which a reader scrolls past).
  // Instant: the site scrolls smoothly, and a mid-scroll box would be stale.
  await button.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(150);
  const box = (await button.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const topmost = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest("button, [role=button]")?.textContent ?? null, [x, y]);
  expect(topmost, `nothing may sit over "${name}"`).toContain(name);
  // A real pointer click at the button's centre: an overlay there would take it.
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5_000 }), page.mouse.click(x, y)]);
  return chooser;
}

/** A fresh first-visit page (cookie notice showing) with chooser interception on. */
async function openFresh(browser: Browser, viewport: { width: number; height: number }, javaScriptEnabled = true) {
  const context = await browser.newContext({ viewport, javaScriptEnabled });
  const page = await context.newPage();
  // Turn on chooser interception before any click: Playwright enables it
  // lazily on the first waitForEvent, which can race the click itself.
  page.on("filechooser", () => undefined);
  await page.goto("/viewer/local");
  return { context, page };
}

// Each picker is opened on its own page, so no chooser ever has to be closed
// (closing a directory chooser needs directory-upload support the CI browser
// may lack).
for (const viewport of SIZES) {
  for (const [name, directory] of [
    ["Choose a folder", true],
    ["Choose files", false],
  ] as const) {
    test(`"${name}" opens a file chooser at ${viewport.width}×${viewport.height} with the cookie notice showing`, async ({ browser }) => {
      const { context, page } = await openFresh(browser, viewport);
      await expect(page.getByText("uses a session cookie")).toBeVisible();
      const chooser = await clickOpensChooser(page, name);
      expect(chooser.isMultiple()).toBe(true);
      const attr = await chooser.element().getAttribute("webkitdirectory");
      if (directory) expect(attr, "folder picker").not.toBeNull();
      else expect(attr, "files picker").toBeNull();
      await context.close();
    });
  }
}

test("the cookie notice still takes its own click", async ({ browser }) => {
  const { context, page } = await openFresh(browser, { width: 1366, height: 600 });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("uses a session cookie")).toBeHidden();
  await context.close();
});

test("dropping study files on the drop zone opens the study", async ({ page }) => {
  test.skip(!process.env.TEST_CT_DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");
  const dir = process.env.TEST_CT_DIR!;
  const names = fs.readdirSync(dir).sort().slice(0, 12);
  const payload = names.map((n) => ({ name: n, b64: fs.readFileSync(path.join(dir, n)).toString("base64") }));
  await page.setViewportSize({ width: 1366, height: 600 });
  await page.goto("/viewer/local");
  const zone = page.getByTestId("local-dropzone");
  const transfer = await page.evaluateHandle((files) => {
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: "application/dicom" }));
    }
    return dt;
  }, payload);
  await zone.dispatchEvent("dragover", { dataTransfer: transfer });
  await zone.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`${names.length} images`).first()).toBeVisible();
});

for (const name of ["Choose a folder", "Choose files"]) {
  test(`"${name}" opens with no script on the click path (before hydration, or with JS off)`, async ({ browser }) => {
    const { context, page } = await openFresh(browser, { width: 1366, height: 600 }, false);
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 5_000 }),
      page.getByRole("button", { name }).click(),
    ]);
    expect(chooser.isMultiple()).toBe(true);
    await context.close();
  });
}

test("keyboard: Enter on the focused picker opens it", async ({ page }) => {
  page.on("filechooser", () => undefined);
  await page.goto("/viewer/local");
  await page.getByRole("button", { name: "Choose a folder" }).focus();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5_000 }), page.keyboard.press("Enter")]);
  expect(chooser.isMultiple()).toBe(true);
});
