import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// After a recovery reload (a new build arrived, lib/chunkRecovery.ts), the
// study the reader chose reopens by itself where the browser still grants
// read access: no "The viewer was updated" screen, no Reopen click, no
// permission prompt. Only where access has lapsed does the browser's own
// prompt (inside a Reopen click) remain.
//
// A real picked-folder handle cannot be made headlessly (and headless
// Chromium crashes reading a stored OPFS handle back), so the remembered
// handle is a stand-in with the File System Access shape, served by a tiny
// IndexedDB stand-in for the viewer's handle store. Synthetic CT only.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

type Fixture = { files: { name: string; b64: string }[]; permission: "granted" | "prompt" };

function rememberStudy(fixture: Fixture) {
  const w = window as unknown as { __promptCount: number };
  w.__promptCount = 0;
  const files = fixture.files.map((f) => new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name));
  const dir = {
    kind: "directory",
    name: "study",
    queryPermission: async () => fixture.permission,
    requestPermission: async () => {
      w.__promptCount += 1;
      return "granted";
    },
    async *values() {
      for (const file of files) yield { kind: "file", name: file.name, getFile: async () => file };
    },
  };
  // The viewer's handle store (lib/studyHandleStore.ts) reads "flowrad-viewer"/"handles"/"open-study".
  const realOpen = indexedDB.open.bind(indexedDB);
  const request = <T,>(result: T) => {
    const req: { result: T; onsuccess: null | (() => void); onerror: null | (() => void) } = { result, onsuccess: null, onerror: null };
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  };
  let stored: unknown = [dir];
  (indexedDB as unknown as { open: unknown }).open = (name: string, version?: number) => {
    if (name !== "flowrad-viewer") return realOpen(name, version);
    const tx = () => {
      const t: { oncomplete: null | (() => void); objectStore: () => unknown } = {
        oncomplete: null,
        objectStore: () => ({
          get: () => request(stored),
          put: (value: unknown) => ((stored = value), request(undefined)),
          delete: () => ((stored = undefined), request(undefined)),
        }),
      };
      setTimeout(() => t.oncomplete?.(), 5);
      return t;
    };
    return request({ transaction: tx, close: () => undefined });
  };
  // Where the reader was before the reload (numbers only).
  sessionStorage.setItem(
    "flowrad:chunk-reload-place",
    JSON.stringify({ path: "/viewer", scrollY: 0, viewer: { study: 0, series: 0, slice: 10 }, savedAt: Date.now() })
  );
}

function fixture(permission: Fixture["permission"]): Fixture {
  return { permission, files: fs.readdirSync(DIR!).map((name) => ({ name, b64: fs.readFileSync(path.join(DIR!, name)).toString("base64") })) };
}

test("readable: the study reopens straight after the update reload, no screen, no click, no prompt", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.addInitScript(rememberStudy, fixture("granted"));
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });
  await page.goto("/viewer");
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("The viewer was updated")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Reopen/ })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __promptCount: number }).__promptCount)).toBe(0);
  expect(dialogs).toBe(0);
});

test("lapsed access: Reopen stays, and the browser's own prompt runs only inside that click", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.addInitScript(rememberStudy, fixture("prompt"));
  await page.goto("/viewer");
  await expect(page.getByText("The viewer was updated")).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { __promptCount: number }).__promptCount)).toBe(0);
  await page.getByRole("button", { name: /Reopen/ }).first().click();
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as unknown as { __promptCount: number }).__promptCount)).toBe(1);
});
