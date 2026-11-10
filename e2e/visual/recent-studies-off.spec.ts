import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// "Remember studies I open", as the desktop's "Local study database" setting:
// on by default; turned off in Help › Customise › Privacy & storage it clears
// the list and keeps nothing from then on; the landing says so and turns it
// back on. A dozen synthetic CT slices in this origin's private file system
// (OPFS), returned by a stubbed folder picker; as in recent-studies.spec.ts the
// handles store's values stay in page memory (this sandbox's Chromium crashes
// reading an OPFS handle back out of IndexedDB).

const DIR = process.env.TEST_CT_DIR;

const recent = (page: Page) => page.getByTestId("recent-studies");
const slider = (page: Page) => page.getByRole("slider", { name: "Slice" }).first();
const image = (page: Page) => page.locator('[role="img"][aria-label^="DICOM viewer"]').first();

const storedCount = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open("flowrad-viewer-recent");
        req.onsuccess = () => {
          const count = req.result.transaction("studies").objectStore("studies").count();
          count.onsuccess = () => {
            req.result.close();
            resolve(count.result);
          };
        };
        req.onerror = () => resolve(-1);
      })
  );

async function openFolder(page: Page) {
  await page.getByRole("button", { name: "Choose a folder" }).click();
  await expect(slider(page)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);
}

async function closeStudy(page: Page) {
  await page.getByRole("button", { name: "Close study" }).first().click();
  await expect(page.getByRole("button", { name: "Choose a folder" })).toBeVisible({ timeout: 10_000 });
}

test("recent studies off: clears the list, keeps nothing, and turns back on from the landing", async ({ page }) => {
  test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    window.localStorage.setItem("radlearn-cookie-ack", "1");
    const held = new Map<IDBValidKey, unknown>();
    const isHandles = (store: IDBObjectStore) => store.name === "handles" && store.transaction.db.name === "flowrad-viewer-recent";
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (!isHandles(this) || key == null) return put.call(this, value, key);
      held.set(key, value);
      return put.call(this, "held in page memory", key);
    };
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (query: IDBValidKey | IDBKeyRange) {
      const req = get.call(this, query);
      if (isHandles(this)) Object.defineProperty(req, "result", { get: () => held.get(query as IDBValidKey) });
      return req;
    };
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle("study-ct");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  const names = fs.readdirSync(DIR!).sort().slice(0, 12);
  const files = names.map((name) => ({ name, b64: fs.readFileSync(path.join(DIR!, name)).toString("base64") }));
  await page.evaluate(async (list) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("study-ct", { recursive: true }).catch(() => undefined);
    const dir = await root.getDirectoryHandle("study-ct", { create: true });
    for (const f of list) {
      const w = await (await dir.getFileHandle(f.name, { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
      await w.close();
    }
  }, files);

  // On by default: an opened folder is listed.
  await openFolder(page);
  await closeStudy(page);
  await expect(recent(page).getByRole("button", { name: /^Reopen / })).toHaveCount(1, { timeout: 10_000 });

  // Turn it off in Help › Customise › Privacy & storage, with a study open.
  await openFolder(page);
  await image(page).click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Shift+?");
  await page.getByRole("dialog", { name: /Viewer shortcuts/ }).getByRole("button", { name: "Customise" }).click();
  const privacy = page.getByRole("region", { name: "Privacy & storage" });
  await expect(privacy).toBeVisible({ timeout: 15_000 });
  const toggle = privacy.getByRole("switch", { name: "Remember studies I open" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(privacy.getByRole("status")).toContainText("Recent studies cleared");
  await expect.poll(() => storedCount(page)).toBe(0);
  await page.getByRole("button", { name: "Close shortcuts" }).click();

  // The landing says it is off; opening the folder again keeps nothing.
  await closeStudy(page);
  await expect(page.getByTestId("recent-studies-off")).toBeVisible();
  await expect(recent(page)).toHaveCount(0);
  await openFolder(page);
  await closeStudy(page);
  await page.waitForTimeout(800);
  expect(await storedCount(page)).toBe(0);
  await expect(recent(page)).toHaveCount(0);

  // Remembered across a reload: still off.
  await page.reload();
  await expect(page.getByTestId("recent-studies-off")).toBeVisible({ timeout: 10_000 });

  // Turn on from the landing: the next folder is listed again.
  await page.getByTestId("recent-studies-off").getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByTestId("recent-studies-off")).toHaveCount(0);
  await openFolder(page);
  await closeStudy(page);
  await expect(recent(page).getByRole("button", { name: /^Reopen / })).toHaveCount(1, { timeout: 10_000 });
  expect(errors).toEqual([]);
});

// Screenshots for people (SCREENSHOT_DIR): sharp at 2×.
const SHOTS = process.env.SCREENSHOT_DIR;
test.describe("screenshot", () => {
  test.use({ deviceScaleFactor: 2 });
  test("recent studies off: screenshots", async ({ page }) => {
    test.skip(!DIR || !SHOTS, "SCREENSHOT_DIR and TEST_CT_DIR are not set");
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      window.localStorage.setItem("radlearn-cookie-ack", "1");
      // A picker so the landing is the folder (Chromium) one.
      (window as unknown as { showDirectoryPicker?: () => Promise<never> }).showDirectoryPicker ??= () => Promise.reject(new Error("no"));
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/viewer");
    const files = fs.readdirSync(DIR!).sort().map((f) => path.join(DIR!, f));
    await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
    await expect(slider(page)).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(600);
    await image(page).click({ position: { x: 30, y: 30 } });
    await page.keyboard.press("Shift+?");
    await page.getByRole("dialog", { name: /Viewer shortcuts/ }).getByRole("button", { name: "Customise" }).click();
    const privacy = page.getByRole("region", { name: "Privacy & storage" });
    await privacy.scrollIntoViewIfNeeded();
    await privacy.getByRole("switch", { name: "Remember studies I open" }).click();
    await expect(privacy.getByRole("status")).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS!, "privacy-setting.png") });
    await page.getByRole("button", { name: "Close shortcuts" }).click();
    await closeStudy(page);
    await expect(page.getByTestId("recent-studies-off")).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS!, "landing-off.png") });
  });
});
