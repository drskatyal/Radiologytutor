import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Voice commands recognised from a fixed RECORDING, through the browser's
// real capture path (Chromium's fake microphone plays the file into
// getUserMedia, exactly where a laptop mic would). The recording is committed:
// e2e/fixtures/voice/commands-room.wav — "next series", "zoom in", "lung
// window", spoken (espeak-ng) and played through a simulated loudspeaker-to-
// microphone path (speaker band, room reflections, pink noise ~25 dB SNR;
// desktop/scripts/make-voice-wav.py --room). Every run hears identical audio,
// so a recognition regression fails here instead of on a reader's desk.
//
// Each command must be recognised AND applied: the series changes, the zoom
// goes above 100 %, the lung window (W 1500 / L −600) is set.

const DIR = process.env.TEST_MULTI_DIR;
const WAV = path.join(__dirname, "..", "fixtures", "voice", "commands-room.wav");
const MODEL = path.join(__dirname, "..", "..", "public", "voice", "model.tar.gz");
test.skip(!DIR || !fs.existsSync(MODEL), "needs TEST_MULTI_DIR (scripts/make-test-multiseries.py) and public/voice/model.tar.gz");

test.use({
  permissions: ["microphone"],
  launchOptions: {
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`],
  },
});

test("voice: recorded WAV through the real capture path — next series, zoom in and lung window are recognised and applied", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/viewer");
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);

  const body = () => page.locator("body").innerText();
  const seriesNo = (text: string) => text.match(/·\s*Se (\d+)/)?.[1] ?? null;
  const zoomPct = (text: string) => Number(text.match(/Zoom (\d+)%/)?.[1] ?? NaN);
  const firstSeries = seriesNo(await body());
  expect(firstSeries, "the overlay names the series").not.toBeNull();

  await page.getByRole("button", { name: /^Voice commands/ }).click();
  await expect(page.getByRole("button", { name: /^Voice commands on/ })).toBeVisible({ timeout: 90_000 });

  // The recording loops; a later "next series" remounts the viewer (zoom and
  // window reset), so each effect is recorded the moment it is seen.
  const seen = { nextSeries: false, zoomIn: false, lungWindow: false };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !(seen.nextSeries && seen.zoomIn && seen.lungWindow)) {
    const text = await body();
    const s = seriesNo(text);
    if (s && s !== firstSeries) seen.nextSeries = true;
    if (zoomPct(text) > 100) seen.zoomIn = true;
    if (/W 1500\s+L [-−]600/.test(text)) seen.lungWindow = true;
    await page.waitForTimeout(250);
  }
  console.log(`voice (recorded): ${JSON.stringify(seen)}`);
  expect(seen, "every spoken command recognised and applied").toEqual({ nextSeries: true, zoomIn: true, lungWindow: true });
  await page.getByRole("button", { name: /^Voice commands on/ }).click();
});
