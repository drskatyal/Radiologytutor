import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// "Compare with prior…" on the image menu, as on the desktop: with a study
// open from a folder, an earlier study of the same patient among the recent
// studies is one right-click away; it reopens both, hung current vs prior.
// Synthetic studies (scripts/make-test-prior.py) written into this origin's
// private file system (OPFS), whose directory handles the stubbed folder
// picker returns in turn. As in recent-studies.spec.ts, the handles store's
// values stay in page memory (this sandbox's Chromium crashes reading an OPFS
// handle back out of IndexedDB); the rest is the real path.

const PRIOR = process.env.TEST_PRIOR_DIR;

const slider = (page: Page) => page.getByRole("slider", { name: "Slice" });
const menuItem = (page: Page, name: RegExp) => page.locator('[role^="menuitem"]').filter({ hasText: name });

const image = (page: Page) => page.locator('[role="img"][aria-label^="DICOM viewer"]').first();

async function rightClickImage(page: Page) {
  const box = (await image(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3, { button: "right" });
  await expect(page.getByRole("menu", { name: "Image" })).toBeVisible();
}

test("compare with prior: the image menu reopens the study with this patient's earlier one, side by side", async ({ page }) => {
  test.skip(!PRIOR, "TEST_PRIOR_DIR is not set (scripts/make-test-prior.py)");
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
    const queue = ["prior", "current", "other"];
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle(queue.shift() ?? "current");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");

  // The three synthetic studies into OPFS, one folder each.
  for (const folder of ["prior", "current", "other"]) {
    const names = fs.readdirSync(path.join(PRIOR!, folder)).sort();
    const files = names.map((name) => ({ name, b64: fs.readFileSync(path.join(PRIOR!, folder, name)).toString("base64") }));
    await page.evaluate(
      async ({ folder, list }) => {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(folder, { recursive: true }).catch(() => undefined);
        const dir = await root.getDirectoryHandle(folder, { create: true });
        for (const f of list) {
          const w = await (await dir.getFileHandle(f.name, { create: true })).createWritable();
          await w.write(Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
          await w.close();
        }
      },
      { folder, list: files }
    );
  }

  // The prior alone: nothing earlier of this patient, so no "Compare with prior…".
  await page.getByRole("button", { name: "Choose a folder" }).click();
  await expect(slider(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(slider(page).first()).toHaveAttribute("aria-valuetext", /of 32$/);
  await page.waitForTimeout(800);
  await rightClickImage(page);
  await expect(menuItem(page, /Compare with prior/)).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The current next: the prior is in the recent studies, so the menu offers it.
  await page.getByRole("button", { name: "Close study" }).first().click();
  await page.getByRole("button", { name: "Choose a folder" }).click();
  await expect(slider(page).first()).toHaveAttribute("aria-valuetext", /of 40$/, { timeout: 30_000 });
  await expect(page.getByRole("radio", { name: "Single layout" })).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => {
      await rightClickImage(page);
      const n = await menuItem(page, /Compare with prior/).count();
      await page.keyboard.press("Escape");
      return n;
    }, { timeout: 10_000 })
    .toBe(1);

  // Compare with prior: both studies, hung current vs prior.
  await rightClickImage(page);
  await menuItem(page, /Compare with prior/).click();
  await expect(page.getByRole("radio", { name: "Side by side layout" })).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await expect(slider(page)).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("hanging-label")).toHaveText("Current 2025-01-01 vs prior 2024-01-05");
  await expect(slider(page).nth(0)).toHaveAttribute("aria-valuetext", /of 40$/);
  await expect(slider(page).nth(1)).toHaveAttribute("aria-valuetext", /of 32$/);

  // Another patient's earlier study is never offered as this patient's prior.
  await page.getByRole("button", { name: "Close study" }).first().click();
  await page.getByRole("button", { name: "Choose a folder" }).click();
  await expect(slider(page).first()).toHaveAttribute("aria-valuetext", /of 40$/, { timeout: 30_000 });
  await page.waitForTimeout(1000);
  await rightClickImage(page);
  await expect(menuItem(page, /Compare with prior/)).toHaveCount(0);
  await page.keyboard.press("Escape");

  // What is kept: no patient name or ID, and no UID.
  const stored = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const req = indexedDB.open("flowrad-viewer-recent");
        req.onsuccess = () => {
          const all = req.result.transaction("studies").objectStore("studies").getAll();
          all.onsuccess = () => resolve(JSON.stringify(all.result));
        };
      })
  );
  expect(stored).toContain("patientKey");
  expect(stored).not.toMatch(/SYNTHETIC\^|TEST\^CT|CI-000|\d+\.\d+\.\d+\.\d+/);
  expect(errors).toEqual([]);
});
