import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Customisable mouse & keyboard bindings (docs/BINDINGS_DESIGN.md) in the free
// viewer: rebind right drag to zoom and a key to a command, bind mouse button
// 5 (a gaming / programmable mouse's 6th button) and F13 (a key mouse software
// sends) to commands — all through the "press the button you want to bind"
// capture — then RELOAD and check every binding still applies and shows in the
// ? sheet. Synthetic CT only (TEST_CT_DIR, scripts/make-test-ct.py).

const DIR = process.env.TEST_MULTI_DIR ?? process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_MULTI_DIR / TEST_CT_DIR is not set (scripts/make-test-ct.py)");
const SHOTS = process.env.SHOT_DIR;

async function open(page: Page) {
  await page.goto("/viewer");
  const consent = page.getByRole("button", { name: "Continue" });
  if (await consent.count()) await consent.first().click();
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(400);
}

const viewer = (page: Page) => page.locator("[data-viewer-tool]").first();

const edges = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const el of document.querySelectorAll<HTMLElement>("[data-edge]")) out[el.dataset.edge!] = el.textContent ?? "";
    return out;
  });

/** Zoom % and window width from the viewport's own overlay / readout. */
const view = (page: Page) =>
  page.evaluate(() => {
    const text = document.body.innerText;
    const zoom = Number(/Zoom (\d+)%/.exec(text)?.[1] ?? NaN);
    const label = [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label") ?? "").find((l) => /window -?\d/.test(l)) ?? "";
    const ww = Number(/window (-?\d+(?:\.\d+)?)/.exec(label)?.[1] ?? NaN);
    return { zoom, ww };
  });

/** A press-and-release of any button, as the OS reports it (Playwright drives only buttons 0–2). */
async function pressButton(page: Page, selector: string, button: number) {
  await page.locator(selector).first().evaluate((el, b) => {
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, button: b, buttons: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 7, pointerType: "mouse" };
    el.dispatchEvent(new PointerEvent("pointerdown", at));
    el.dispatchEvent(new PointerEvent("pointerup", at));
    el.dispatchEvent(new MouseEvent("mouseup", at));
    el.dispatchEvent(new MouseEvent("auxclick", at));
  }, button);
}

/** F13: what mouse software sends for a programmed button (Playwright's keyboard stops at F12). */
const pressF13 = (pg: Page) =>
  pg.evaluate(() => {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    for (const type of ["keydown", "keyup"]) target.dispatchEvent(new KeyboardEvent(type, { key: "F13", code: "F13", bubbles: true, cancelable: true, composed: true }));
  });

async function rightDrag(page: Page) {
  const box = (await viewer(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "right" });
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 4, y - i * 12);
  await page.mouse.up({ button: "right" });
  await page.keyboard.press("Escape").catch(() => undefined);
}

test("bindings: rebind right drag + a key, bind mouse button 5 and F13; all survive a reload and show in the ? sheet", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await open(page);

  // Default preset: right drag windows (W/L), it does not zoom.
  const before = await view(page);
  await rightDrag(page);
  const afterDefault = await view(page);
  expect(afterDefault.ww, "right drag = window / level by default").not.toBe(before.ww);
  expect(afterDefault.zoom).toBe(before.zoom);

  // Open the sheet (?), then Customise.
  await viewer(page).click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Shift+?");
  const sheet = page.getByRole("dialog", { name: /Viewer shortcuts/ });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Customise" }).click();
  const panel = page.locator("[data-bindings-panel=web]");
  await expect(panel).toBeVisible({ timeout: 15_000 });

  // Mouse tab: right drag → Zoom.
  await panel.getByRole("combobox", { name: "Command for Right drag" }).selectOption({ label: "Zoom" });
  await expect(panel.getByRole("status")).toContainText("Right drag → Zoom");

  // Keyboard tab.
  await panel.getByRole("tab", { name: /Keyboard/ }).click();
  const row = (id: string) => panel.locator(`[data-binding-row="${id}"]`);

  // Invert → J (a plain key re-map).
  await row("invert").getByRole("button", { name: "Change the binding for Invert" }).click();
  await page.keyboard.press("j");
  await expect(row("invert")).toContainText("Received");
  await row("invert").getByRole("button", { name: "Save" }).click();
  await expect(row("invert")).toContainText("J");

  // Flip horizontal ← F13 (what mouse software sends for a programmed button).
  await row("flip.h").getByRole("button", { name: "Change the binding for Flip horizontal" }).click();
  await pressF13(page);
  await expect(row("flip.h")).toContainText("F13");
  await row("flip.h").getByRole("button", { name: "Save" }).click();

  // Rotate clockwise + mouse button 5 (PointerEvent.button 5: the 6th button).
  await row("rotate.cw").getByRole("button", { name: "Add another input for Rotate 90° clockwise" }).click();
  await pressButton(page, "[data-binding-capture]", 5);
  await expect(row("rotate.cw")).toContainText("Mouse button 6");
  await row("rotate.cw").getByRole("button", { name: "Save" }).click();
  await expect(row("rotate.cw")).toContainText("R");
  await expect(row("rotate.cw")).toContainText("Mouse button 6");

  // A conflict asks first: S is Scroll — swap or cancel.
  await row("tool.rect").getByRole("button", { name: "Change the binding for Rectangle ROI" }).click();
  await page.keyboard.press("s");
  await expect(row("tool.rect")).toContainText("is already Scroll — swap or cancel?");
  await row("tool.rect").getByRole("button", { name: "Cancel" }).click();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "web-bindings-panel.png") });

  const stored = await page.evaluate(() => window.localStorage.getItem("flowrad.bindings"));
  expect(JSON.parse(stored!).overrides).toMatchObject({
    "drag.zoom": ["Mouse2Drag"],
    invert: ["J"],
    "flip.h": ["F13"],
    "rotate.cw": ["R", "Mouse5"],
  });

  // ── Reload: everything still applies. ──
  await page.reload();
  await open(page);
  await viewer(page).click({ position: { x: 30, y: 30 } });
  const start = await edges(page);
  expect(start).toEqual({ top: "A", bottom: "P", left: "R", right: "L" });

  // F13 flips horizontally; H no longer does.
  await page.keyboard.press("h");
  await expect.poll(() => edges(page)).toEqual(start);
  await pressF13(page);
  await expect.poll(() => edges(page)).toEqual({ top: "A", bottom: "P", left: "L", right: "R" });
  await pressF13(page);
  await expect.poll(() => edges(page)).toEqual(start);

  // Mouse button 5 rotates 90° clockwise.
  await pressButton(page, "[data-viewer-tool]", 5);
  await expect.poll(() => edges(page)).toEqual({ top: "R", bottom: "L", left: "P", right: "A" });
  await page.keyboard.press("Shift+R");
  await expect.poll(() => edges(page)).toEqual(start);

  // Right drag now zooms (and leaves the window alone).
  const z0 = await view(page);
  await rightDrag(page);
  const z1 = await view(page);
  expect(z1.zoom, "right drag = zoom after the rebind").not.toBe(z0.zoom);
  expect(z1.ww).toBe(z0.ww);

  // J inverts.
  await viewer(page).click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("j");
  await expect(page.getByText(/Invert on/).first()).toBeVisible();

  // The ? sheet lists the reader's bindings.
  await page.keyboard.press("Shift+?");
  const sheet2 = page.getByRole("dialog", { name: /Viewer shortcuts/ });
  await expect(sheet2).toBeVisible();
  await expect(sheet2).toContainText("F13");
  await expect(sheet2).toContainText("Mouse button 6");
  await expect(sheet2).toContainText("Right drag");
  const zoomRow = sheet2.locator("li", { hasText: "Right drag" });
  await expect(zoomRow).toContainText("Zoom");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "web-bindings-sheet.png") });
});
