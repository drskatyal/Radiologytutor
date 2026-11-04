import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The viewer plugin host, end to end, with a TEST FIXTURE plugin
// (e2e/fixtures/plugins/e2e-demo-plugin.js). Runs only with PLUGIN_E2E=1
// (playwright.visual.config.ts turns the host on); without it, checks that the
// viewer ships with plugins OFF: no panel, no plugin request.

const FIXTURE = path.join(__dirname, "..", "fixtures", "plugins", "e2e-demo-plugin.js");
const DIR = process.env.TEST_CT_DIR;

test("plugins are off by default: no panel, no plugin fetch", async ({ page }) => {
  test.skip(!!process.env.PLUGIN_E2E, "the server was started with plugins on");
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/viewer");
  await expect(page.getByTestId("plugin-panel")).toHaveCount(0);
  expect(requests.filter((u) => u.includes("plugin"))).toEqual([]);
});

test("a pinned plugin gets the panel, commands, state, overlay, hotkey and mic hook", async ({ page }) => {
  test.skip(!process.env.PLUGIN_E2E || !DIR, "needs PLUGIN_E2E=1 and TEST_CT_DIR");
  test.setTimeout(120_000);
  await page.route("**/__e2e/plugins/e2e-demo-plugin.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: fs.readFileSync(FIXTURE) })
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });

  const rail = page.getByRole("navigation", { name: "Plugins" });
  await rail.getByRole("button", { name: "E2E demo" }).click();
  const panel = page.getByRole("region", { name: "E2E demo plugin" });
  const state = panel.getByTestId("e2e-state");
  await expect(state).toContainText('"series":0');

  const click = async (label: string) => {
    const b = panel.getByRole("button", { name: label, exact: true });
    // No navigation follows a command; and "3D MPR" builds a volume, which on
    // a CI runner's software GPU keeps the page busy for a while.
    await b.click({ noWaitAfter: true });
    await expect(b).toHaveAttribute("data-result", /.+/, { timeout: 60_000 });
    return b.getAttribute("data-result");
  };
  // The viewer opens on the middle slice; read where it is before scrolling.
  await expect(state).toContainText('"slice":');
  const start = JSON.parse((await state.textContent())!).slice as number;
  expect(await click("scroll +5")).toBe("ok");
  await expect(state).toContainText(`"slice":${start + 5}`);
  expect(await click("bone")).toBe("ok");
  expect(await click("zoom")).toBe("ok");
  expect(await click("key image")).toBe(`key:image/jpeg:${start + 5}`);
  expect(await click("overlay")).toBe("ok");
  await expect(page.getByTestId("plugin-overlay").getByTestId("e2e-overlay")).toBeVisible();
  expect(await click("3D MPR")).toBe("ok");
  // 3D where the device has a WebGL2 volume pipeline; otherwise the viewer
  // falls back to MPR and says so. Either way the state reports the truth.
  await expect(state).toContainText(/"mode":"(3d|mpr)"/, { timeout: 60_000 });
  expect(await click("axial")).toBe("ok");
  await expect(state).toContainText('"mode":"stack"', { timeout: 60_000 });

  await page.locator("canvas").first().click();
  await page.keyboard.press("Alt+Shift+KeyK");
  await expect(state).toHaveAttribute("data-hotkeys", "1");
  await page.keyboard.down("Alt");
  await page.keyboard.down("Shift");
  await page.keyboard.down("KeyM");
  await expect(state).toHaveAttribute("data-mic", "on");
  await page.keyboard.up("KeyM");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Alt");
  await expect(state).toHaveAttribute("data-mic", "off");
  await expect(panel.getByRole("button", { name: /Dictate/ })).toBeVisible();
});

test("a plugin file that does not match its pin is refused", async ({ page }) => {
  test.skip(!process.env.PLUGIN_E2E || !DIR, "needs PLUGIN_E2E=1 and TEST_CT_DIR");
  await page.route("**/__e2e/plugins/e2e-demo-plugin.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: "window.__pwned = true; export default { id: 'e2e-demo', name: 'Evil', apiVersion: 1, activate() {} }",
    })
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("navigation", { name: "Plugins" }).getByRole("button", { name: "e2e-demo" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "does not match its pinned SHA-256" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned ?? false)).toBe(false);
});
