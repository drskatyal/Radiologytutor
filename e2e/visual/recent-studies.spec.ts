import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Recent studies on the free viewer's landing, as the desktop keeps them:
// a study opened from a folder is listed (newest first) with no patient
// details, survives a reload, reopens in one click, and can be forgotten.
//
// The folder is real: a dozen synthetic CT slices written into this origin's
// private file system (OPFS), whose directory handle the stubbed folder
// picker returns. One stand-in: this sandbox's Chromium crashes the renderer
// when an OPFS handle is read back out of IndexedDB, so the test keeps the
// handles store's values in page memory (put / get on that one store only).
// Everything else (the entries, their persistence, reopen through the
// browser's permission check) is the real path.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

const slider = (page: Page) => page.getByRole("slider", { name: "Slice" }).first();
const recent = (page: Page) => page.getByTestId("recent-studies");

test("recent studies: listed with no patient details, survive a reload, reopen in one click, forget", async ({ page }) => {
  test.setTimeout(120_000);
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

  // A dozen slices of the synthetic CT into OPFS.
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

  // Nothing yet.
  await expect(page.getByRole("button", { name: "Choose a folder" })).toBeVisible();
  await expect(recent(page)).toHaveCount(0);

  // Open the folder, then close the study: it is listed.
  await page.getByRole("button", { name: "Choose a folder" }).click();
  await expect(slider(page)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Close study" }).first().click();
  await expect(recent(page)).toBeVisible({ timeout: 10_000 });
  const row = recent(page).getByRole("button", { name: /^Reopen / });
  await expect(row).toHaveCount(1);
  await expect(recent(page)).toContainText("Recent studies");
  await expect(recent(page)).toContainText(/CT · .*1 series, 12 images/);

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
  expect(stored).toContain("12");
  expect(stored).not.toMatch(/TEST\^CT|CI-0001|\d+\.\d+\.\d+\.\d+/);
  expect(await recent(page).innerText()).not.toMatch(/TEST\^CT|CI-0001/);

  // A reload keeps the list.
  await page.reload();
  await expect(recent(page).getByRole("button", { name: /^Reopen / })).toHaveCount(1, { timeout: 10_000 });

  // The same folder again: still one entry (newest), then one click reopens it.
  await page.getByRole("button", { name: "Choose a folder" }).click();
  await expect(slider(page)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Close study" }).first().click();
  await expect(recent(page).getByRole("button", { name: /^Reopen / })).toHaveCount(1, { timeout: 10_000 });
  await recent(page).getByRole("button", { name: /^Reopen / }).click();
  await expect(slider(page)).toBeVisible({ timeout: 30_000 });

  // Forget it: the list goes.
  await page.getByRole("button", { name: "Close study" }).first().click();
  await expect(recent(page)).toBeVisible({ timeout: 10_000 });
  await recent(page).getByRole("button", { name: /^Forget / }).click();
  await expect(recent(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Choose a folder" })).toBeVisible();
  await expect(recent(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});
