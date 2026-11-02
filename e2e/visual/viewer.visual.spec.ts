import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Visual regression + perf gate for the web viewer (/viewer/local).
//
// Opens the deterministic synthetic CT (scripts/make-test-ct.py, TEST_CT_DIR)
// at desktop, tablet, phone and phone-landscape sizes and compares what the
// image canvas shows — downsampled to 96×96 luminance — with the committed
// baseline. Comparing the image pixels, not a full-page screenshot, keeps the
// gate about rendering (windowing, orientation, scroll position, fit) and
// stable across font hinting; layout is gated by explicit geometry checks.
// Full screenshots are attached to every run for review.
//
// UPDATE_VISUAL=1 rewrites the baselines (review the diff before committing).

const DIR = process.env.TEST_CT_DIR;
const BASELINES = path.join(__dirname, "baselines");
const UPDATE = process.env.UPDATE_VISUAL === "1";
const SIDE = 96;
/** Mean |Δ| over the 96×96 sample, in 8-bit levels. */
const MAX_MEAN_DIFF = 1.5;
/** Share of samples allowed to differ by more than 24 levels. */
const MAX_OUTLIERS = 0.005;
/** First image budgets (ms, local files, CI runner + SwiftShader). */
const FIRST_IMAGE_BUDGET_MS = { desktop: 2000, mobile: 2000 };
/** Every run writes its samples here (CI uploads them): promote with care if a browser update moves pixels. */
const ACTUAL_DIR = path.join(__dirname, "..", "..", "test-results", "visual-actual");

const SIZES = [
  { name: "desktop-1440", viewport: { width: 1440, height: 900 }, mobile: false },
  { name: "tablet-768", viewport: { width: 768, height: 1024 }, mobile: true },
  { name: "phone-390", viewport: { width: 390, height: 844 }, mobile: true },
  { name: "phone-landscape", viewport: { width: 844, height: 390 }, mobile: true },
] as const;

async function sampleCanvas(page: Page): Promise<number[]> {
  return page.evaluate((side) => {
    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
    if (!c || !c.width) return [];
    const probe = document.createElement("canvas");
    probe.width = probe.height = side;
    const ctx = probe.getContext("2d")!;
    // Letterbox to a square, centred, so the sample is independent of aspect.
    const s = Math.min(c.width, c.height);
    ctx.drawImage(c, (c.width - s) / 2, (c.height - s) / 2, s, s, 0, 0, side, side);
    const d = ctx.getImageData(0, 0, side, side).data;
    const out: number[] = [];
    for (let i = 0; i < d.length; i += 4) out.push(Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]));
    return out;
  }, SIDE);
}

async function waitPainted(page: Page): Promise<void> {
  await expect
    .poll(async () => Math.max(0, ...(await sampleCanvas(page))), { timeout: 30_000, intervals: [50] })
    .toBeGreaterThan(40);
}

function compare(name: string, actual: number[]): { meanDiff: number; outliers: number } {
  const file = path.join(BASELINES, `${name}.json`);
  fs.mkdirSync(ACTUAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(ACTUAL_DIR, `${name}.json`), JSON.stringify({ side: SIDE, pixels: Buffer.from(actual).toString("base64") }) + "\n");
  if (UPDATE || !fs.existsSync(file)) {
    if (!UPDATE) throw new Error(`no baseline ${file}; run with UPDATE_VISUAL=1 and review it`);
    fs.mkdirSync(BASELINES, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ side: SIDE, pixels: Buffer.from(actual).toString("base64") }) + "\n");
    return { meanDiff: 0, outliers: 0 };
  }
  const base = Array.from(Buffer.from(JSON.parse(fs.readFileSync(file, "utf8")).pixels, "base64"));
  expect(actual.length, `${name}: sample size`).toBe(base.length);
  let sum = 0;
  let out = 0;
  for (let i = 0; i < base.length; i += 1) {
    const d = Math.abs(actual[i] - base[i]);
    sum += d;
    if (d > 24) out += 1;
  }
  const r = { meanDiff: sum / base.length, outliers: out / base.length };
  console.log(`${name}: mean |Δ| ${r.meanDiff.toFixed(2)}, outliers ${(r.outliers * 100).toFixed(2)}%`);
  return r;
}

async function openStudy(page: Page): Promise<number> {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/viewer/local");
  const consent = page.getByRole("button", { name: "Continue" });
  if (await consent.count()) await consent.first().click();
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  const t0 = Date.now();
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(files);
  await waitPainted(page);
  const firstImageMs = Date.now() - t0;
  // Let progressive passes and the overlay settle before sampling.
  await page.waitForTimeout(800);
  return firstImageMs;
}

test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

for (const size of SIZES) {
  test(`viewer renders and lays out at ${size.name}`, async ({ browser }, info) => {
    const context = await browser.newContext({
      viewport: size.viewport,
      hasTouch: size.mobile,
      isMobile: size.mobile,
      deviceScaleFactor: size.mobile ? 2 : 1,
    });
    const page = await context.newPage();
    const firstImageMs = await openStudy(page);
    info.annotations.push({ type: "firstImageMs", description: String(firstImageMs) });
    console.log(`${size.name}: first image ${firstImageMs} ms`);
    expect(firstImageMs, "first image budget").toBeLessThan(size.mobile ? FIRST_IMAGE_BUDGET_MS.mobile : FIRST_IMAGE_BUDGET_MS.desktop);

    // Layout: no sideways page scroll, the image on screen and of a usable size.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "horizontal page scroll").toBeLessThanOrEqual(0);
    const box = (await page.locator("canvas").first().boundingBox())!;
    expect(box.width, "image width").toBeGreaterThan(size.viewport.width * (size.mobile ? 0.8 : 0.5));

    // Pixels: the opening slice, then ten slices on.
    await info.attach(`${size.name}.png`, { body: await page.screenshot(), contentType: "image/png" });
    const first = compare(`${size.name}-open`, await sampleCanvas(page));
    await page.locator("canvas").first().click({ position: { x: box.width / 2, y: box.height / 2 } });
    for (let i = 0; i < 10; i += 1) await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(600);
    const scrolled = compare(`${size.name}-slice+10`, await sampleCanvas(page));
    for (const [label, r] of [["open", first], ["slice+10", scrolled]] as const) {
      expect(r.meanDiff, `${size.name} ${label}: mean |Δ| vs baseline`).toBeLessThanOrEqual(MAX_MEAN_DIFF);
      expect(r.outliers, `${size.name} ${label}: outlier share vs baseline`).toBeLessThanOrEqual(MAX_OUTLIERS);
    }

    if (size.mobile && size.viewport.width < 1024) {
      // Phone/tablet chrome: the series drawer and fullscreen (#92).
      await page.getByRole("button", { name: "Show series" }).tap();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
      await page.getByRole("button", { name: "Fullscreen" }).tap();
      await page.waitForTimeout(1200);
      const fs = (await page.locator("canvas").first().boundingBox())!;
      expect(fs.height / size.viewport.height, "fullscreen image height share").toBeGreaterThan(0.55);
      const zoom = Number((await page.locator("body").innerText()).match(/Zoom (\d+)%/)?.[1]);
      expect(zoom, "fullscreen fits the image").toBeLessThanOrEqual(105);
      await info.attach(`${size.name}-fullscreen.png`, { body: await page.screenshot(), contentType: "image/png" });
    }
    await context.close();
  });
}
