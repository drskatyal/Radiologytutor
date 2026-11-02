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
  page.on("request", (r) => /vosk|\/voice\/model/.test(r.url()) && voiceRequests.push(r.url()));
  await page.setViewportSize({ width: 1440, height: 1200 });
  await openStudy(page);
  expect(voiceRequests, "nothing loaded before the mic is on").toEqual([]);
  const workersBefore = page.workers().length;

  // On failure, say why: the page's console and what the voice button says.
  const consoleLines: string[] = [];
  page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
  page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`.slice(0, 300)));
  await page.getByRole("button", { name: /^Voice commands/ }).click();
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
  expect(page.workers().length).toBeGreaterThan(workersBefore);

  // The fake microphone loops "layout two", "lung window", "zoom in".
  await expect
    // Overlay window line: "W 1500  L −600" (minus sign may be U+2212).
    .poll(async () => /W 1500\s+L [-−]600/.test(await page.locator("body").innerText()), { timeout: 45_000, intervals: [500] })
    .toBe(true);

  await page.getByRole("button", { name: /^Voice commands on/ }).click();
  await expect(page.getByRole("button", { name: /^Voice commands$/ })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(800);
  expect(page.workers().length, "the recognizer worker is terminated").toBeLessThanOrEqual(workersBefore);
});
