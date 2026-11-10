import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The study library, as the desktop's archive: "Keep in this browser" copies
// the open study's files into this origin's private file system (OPFS), so
// it reopens from Recent studies after its folder is gone (a disc ejected, a
// USB stick pulled); Forget removes the copy. Synthetic CT slices in OPFS,
// returned by a stubbed folder picker; the handles store's values stay in
// page memory, as in recent-studies.spec.ts. Help › Customise lists the kept
// studies and removes them all, as the desktop's archive Clear.

const DIR = process.env.TEST_CT_DIR;
const recent = (page: Page) => page.getByTestId("recent-studies");
const slider = (page: Page) => page.getByRole("slider", { name: "Slice" }).first();

/** Entries under OPFS/flowrad-library (one per kept study). */
const keptCount = (page: Page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      const lib = (await root.getDirectoryHandle("flowrad-library")) as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
      let n = 0;
      for await (const name of lib.keys()) if (!name.startsWith(".")) n += 1;
      return n;
    } catch {
      return 0;
    }
  });

test("study library: keep a copy, reopen it after the folder is gone, forget removes it", async ({ page }) => {
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
    for (const n of ["study-ct", "flowrad-library"]) await root.removeEntry(n, { recursive: true }).catch(() => undefined);
    const dir = await root.getDirectoryHandle("study-ct", { create: true });
    for (const f of list) {
      const w = await (await dir.getFileHandle(f.name, { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
      await w.close();
    }
  }, files);

  // Open the folder and keep it.
  await page.getByRole("button", { name: "Choose a folder" }).click();
  await expect(slider(page)).toBeVisible({ timeout: 30_000 });
  const library = page.getByTestId("study-library");
  await expect(library).toBeVisible({ timeout: 10_000 });
  await library.getByRole("button", { name: /^Keep in this browser \(\d+ (KB|MB)\)$/ }).click();
  await expect(library).toContainText(/Kept in this browser · \d+ (KB|MB)/, { timeout: 30_000 });
  expect(await keptCount(page)).toBe(1);

  // Help › Customise › Privacy & storage lists it, and Remove all deletes every copy.
  await page.locator('[role="img"][aria-label^="DICOM viewer"]').first().click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Shift+?");
  await page.getByRole("dialog", { name: /Viewer shortcuts/ }).getByRole("button", { name: "Customise" }).click();
  const kept = page.getByTestId("kept-studies");
  await expect(kept).toContainText(/1 study · \d+ (KB|MB) in this browser/, { timeout: 15_000 });
  await kept.getByRole("button", { name: "Remove all" }).click();
  await expect(page.getByText("Kept copies removed.")).toBeVisible();
  await expect(kept).toContainText("None.");
  await expect.poll(() => keptCount(page)).toBe(0);
  await page.getByRole("button", { name: "Close shortcuts" }).click();
  // The open study's control offers Keep again; keep it for the rest of the test.
  await library.getByRole("button", { name: /^Keep in this browser/ }).click();
  await expect(library).toContainText(/Kept in this browser · /, { timeout: 30_000 });
  expect(await keptCount(page)).toBe(1);

  // The folder goes away (a disc ejected); the study still reopens from Recent studies.
  await page.getByRole("button", { name: "Close study" }).first().click();
  await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry("study-ct", { recursive: true }));
  await expect(recent(page).getByTestId("kept-badge")).toHaveCount(1, { timeout: 10_000 });
  await recent(page).getByRole("button", { name: /^Reopen / }).click();
  await expect(slider(page)).toBeVisible({ timeout: 30_000 });
  await expect(slider(page)).toHaveAttribute("aria-valuetext", /of 12$/);
  await expect(page.getByTestId("study-library")).toContainText("Kept in this browser", { timeout: 10_000 });

  // Forget removes the copy too.
  await page.getByRole("button", { name: "Close study" }).first().click();
  await recent(page).getByRole("button", { name: /^Forget / }).click();
  await expect(recent(page)).toHaveCount(0);
  await expect.poll(() => keptCount(page)).toBe(0);
  expect(errors).toEqual([]);
});
