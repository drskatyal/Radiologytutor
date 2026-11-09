import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Offline voice commands on the web viewer (/viewer/local), with Chromium's
// fake microphone playing spoken commands (desktop/scripts/make-voice-wav.py):
// the recognizer loads only when the mic is switched on, "lung window" sets
// the lung preset, and switching off removes the recognizer's worker.

const DIR = process.env.TEST_CT_DIR;
const WAV = process.env.TEST_VOICE_WAV;
const MODEL = path.join(__dirname, "..", "..", "public", "voice", "model.tar.gz");
test.skip(!DIR || !WAV || !fs.existsSync(MODEL), "needs TEST_CT_DIR, TEST_VOICE_WAV and public/voice/model.tar.gz (scripts/fetch-voice-model.py)");

test.use({
  permissions: ["microphone"],
  launchOptions: {
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      ...(WAV ? [`--use-file-for-fake-audio-capture=${path.resolve(WAV)}`] : []),
    ],
  },
});

async function openStudy(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/viewer/local");
  const consent = page.getByRole("button", { name: "Continue" });
  if (await consent.count()) await consent.first().click();
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(files);
  await page.waitForSelector('[data-testid="annotation-state"]', { state: "attached", timeout: 30_000 });
  await page.waitForTimeout(1000);
}

test("voice: loads on demand, “lung window” applies the preset, off frees the worker", async ({ page }) => {
  test.setTimeout(180_000);
  const voiceRequests: string[] = [];
  page.on("request", (r) => /vosk|recognizer-worker|\/voice\/model/.test(r.url()) && voiceRequests.push(r.url()));
  await page.setViewportSize({ width: 1440, height: 1200 });
  await openStudy(page);
  expect(voiceRequests, "nothing loaded before the mic is on").toEqual([]);

  // On failure, say why: the page's console and what the voice button says.
  const consoleLines: string[] = [];
  page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
  page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`.slice(0, 300)));
  // Worker timeline, for the failure message (which recognizer lived when).
  const t0 = Date.now();
  const timeline: string[] = [];
  page.on("worker", (w) => {
    const name = w.url().split("/").pop();
    timeline.push(`+${name}@${Date.now() - t0}`);
    w.on("close", () => timeline.push(`-${name}@${Date.now() - t0}`));
  });
  const clicked = Date.now();
  await page.getByRole("button", { name: /^Voice commands/ }).click();
  timeline.push(`click-on@${Date.now() - t0}`);
  // Loading shows a real progress card (never a bare spinner).
  await expect(page.getByTestId("voice-status")).toBeVisible({ timeout: 5_000 });
  const on = await page
    .getByRole("button", { name: /^Voice commands on/ })
    .waitFor({ timeout: 90_000 })
    .then(() => true, () => false);
  if (!on) {
    const labels = await page.getByRole("button", { name: /^Voice commands/ }).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    const toasts = await page.locator('[role="status"], [role="alert"]').allInnerTexts();
    throw new Error(
      `voice never turned on. button: ${JSON.stringify(labels)}; toasts: ${JSON.stringify(toasts)}; requests: ${JSON.stringify(voiceRequests)}; console:\n${consoleLines.slice(-25).join("\n")}`
    );
  }
  const readyMs = Date.now() - clicked;
  console.log(`voice: ready ${readyMs} ms after the click (cold: model downloaded and loaded)`);
  test.info().annotations.push({ type: "voice-ready-ms", description: String(readyMs) });
  expect(readyMs, "ready well within the stall timeout").toBeLessThan(20_000);
  await expect(page.getByTestId("voice-status")).toHaveCount(0);
  const recognizers = () => page.workers().filter((w) => /recognizer-worker/.test(w.url()));
  expect(recognizers().length, "the recognizer runs in its own worker").toBe(1);

  // The fake microphone loops "layout two", "lung window", "zoom in".
  await expect
    // Overlay window line: "W 1500  L −600" (minus sign may be U+2212).
    .poll(async () => /W 1500\s+L [-−]600/.test(await page.locator("body").innerText()), { timeout: 45_000, intervals: [500] })
    .toBe(true);

  timeline.push(`click-off@${Date.now() - t0}`);
  await page.getByRole("button", { name: /^Voice commands on/ }).click();
  await expect(page.getByRole("button", { name: /^Voice commands$/ })).toBeVisible({ timeout: 10_000 });
  // The recognizer's own worker is gone (engine decode workers may come and go).
  await expect
    .poll(() => recognizers().length, { timeout: 5_000, message: `the recognizer worker is terminated; timeline: ${timeline.join(" ")}` })
    .toBe(0);
});

test("voice: a missing model is an error with Retry, not an endless load; Retry then works", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await openStudy(page);
  await page.route("**/voice/model.tar.gz", (route) => route.fulfill({ status: 404, body: "not here" }));
  await page.getByRole("button", { name: /^Voice commands/ }).click();
  const card = page.getByTestId("voice-status");
  await expect(card).toHaveAttribute("data-voice-state", "error", { timeout: 15_000 });
  await expect(card).toContainText("not included in this build");
  await page.unroute("**/voice/model.tar.gz");
  await page.getByTestId("voice-retry").click();
  await expect(page.getByRole("button", { name: /^Voice commands on/ })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: /^Voice commands on/ }).click();
});

test("voice: a blocked microphone says so (with Retry), the load stops", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
  });
  await page.setViewportSize({ width: 1440, height: 1200 });
  await openStudy(page);
  await page.getByRole("button", { name: /^Voice commands/ }).click();
  const card = page.getByTestId("voice-status");
  await expect(card).toHaveAttribute("data-voice-state", "error", { timeout: 15_000 });
  await expect(card).toContainText("Microphone access is blocked");
  await expect(page.getByTestId("voice-retry")).toBeVisible();
  await page.waitForTimeout(500);
  expect(page.workers().filter((w) => /recognizer-worker/.test(w.url())).length, "the recognizer is freed after the failure").toBe(0);
});

test("voice: Ctrl+Shift+V on the image switches voice commands on and off, as on the desktop", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await openStudy(page);
  const image = page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
  await image.focus();
  await page.keyboard.press("Control+Shift+KeyV");
  await expect(page.getByRole("button", { name: /^Voice commands on/ })).toBeVisible({ timeout: 90_000 });
  await image.focus();
  await page.keyboard.press("Control+Shift+KeyV");
  await expect(page.getByRole("button", { name: /^Voice commands$/ })).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => page.workers().filter((w) => /recognizer-worker/.test(w.url())).length, { timeout: 5_000 }).toBe(0);
  // The help sheet lists it.
  await image.focus();
  await page.keyboard.press("Shift+?");
  await expect(page.getByRole("dialog").getByText("Voice commands on / off")).toBeVisible();
});
