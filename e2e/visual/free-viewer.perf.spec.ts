import { expect, test, type Browser, type CDPSession, type Page, type Request } from "@playwright/test";
import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";

// Perf + privacy gate for the free, public FlowRad Viewer (/viewer).
//
// Real-size studies, generated deterministically in CI:
//   • CT 520 slices, 512², uncompressed (scripts/make-test-ct.py --slices 520) → TEST_CT_LARGE_DIR
//     opened as a FOLDER through the directory input.
//   • Brain MR, 5 series / 216 images, JPEG 2000 lossless (scripts/make-test-mr.py) → TEST_MR_DIR
//     opened as a deflated ZIP (with a DICOMDIR and macOS noise inside).
//
// Gates (every PR):
//   first image      ≤ FIRST_IMAGE_BUDGET_MS from files received to first pixel painted
//   scroll           no main-thread task > LONG_TASK_BUDGET_MS while scrolling the 520-slice
//                    stack; p95 frame interval ≤ FRAME_P95_BUDGET_MS (60 fps = 16.7 ms)
//   memory           on an emulated 2 GB device the decoded cache stays under its cap through a
//                    full scroll (eviction works, the tab survives); Close study frees it to 0
//   lazy codecs      the uncompressed CT fetches no WASM; the J2K MR fetches only OpenJPEG
//   privacy          after the drop, the page makes no request except GETs for its own static
//                    chunks; no request or console line carries a header value or UID
//
// Results land in test-results/perf/free-viewer.json; scripts/perf/viewer-perf-table.mjs turns
// them (plus the bundle budget) into the table posted on the PR and in the job summary.

const CT_DIR = process.env.TEST_CT_LARGE_DIR;
const MR_DIR = process.env.TEST_MR_DIR;
const OUT_DIR = path.join(__dirname, "..", "..", "test-results", "perf");
const OUT_FILE = path.join(OUT_DIR, "free-viewer.json");

const FIRST_IMAGE_BUDGET_MS = Number(process.env.FIRST_IMAGE_BUDGET_MS ?? 1000);
const LONG_TASK_BUDGET_MS = 50;
/** 60 fps on a real GPU. */
const FRAME_P95_BUDGET_MS = 20;
/**
 * CI runners have no GPU: Chromium renders WebGL and composites in SwiftShader
 * (software), which paces frames at ~30 fps however idle the main thread is.
 * There the frame gate is a regression floor (never below 30 fps); the
 * main-thread long-task gate is the same everywhere.
 */
const FRAME_P95_SOFTWARE_GPU_BUDGET_MS = 34;
const SCROLL_STEPS = 240;

// Chromium with a GPU accelerates 2D canvases by default, so the viewer's
// WebGL → 2D-canvas copy is a GPU blit. Headless Chromium on a GPU-less runner
// keeps 2D canvases in software unless told otherwise, which turns that copy
// into a ~14 ms main-thread readback per frame that no user with a GPU pays.
// These flags give the CI browser the same canvas path as a desktop Chrome.
const GPU_CANVAS_FLAGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--enable-gpu-rasterization",
  "--ignore-gpu-blocklist",
  "--enable-features=Canvas2DGPU",
];
test.use({
  launchOptions: {
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    args: [...(process.env.PW_CHROMIUM_PATH ? ["--headless", "--no-sandbox"] : []), ...GPU_CANVAS_FLAGS],
  },
});

/** Strings that appear only inside the fixtures' headers. None may leave the page or hit a console. */
const IDENTIFIERS = ["TEST^CT", "TEST^MR", "CI-0001", "CI-0002", "1.2.826.0.1.3680043.10.1078", "SYNTHETIC"];

type Results = Record<string, unknown>;
function record(key: string, value: unknown): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const current: Results = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, "utf8")) : {};
  current[key] = value;
  fs.writeFileSync(OUT_FILE, JSON.stringify(current, null, 2));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
const round = (n: number) => Math.round(n * 10) / 10;

/** Watch every request and console line from the moment of the drop. */
function watchPrivacy(page: Page) {
  const after: Request[] = [];
  const consoleLines: string[] = [];
  let armed = false;
  page.on("request", (request) => {
    if (armed) after.push(request);
  });
  page.on("console", (message) => consoleLines.push(message.text()));
  page.on("pageerror", (error) => consoleLines.push(String(error)));
  return {
    arm: () => {
      armed = true;
    },
    /** Every privacy violation seen so far (empty = clean). */
    violations: () => {
      const out: string[] = [];
      const origin = new URL(page.url()).origin;
      for (const request of after) {
        const url = new URL(request.url());
        if (request.method() !== "GET") out.push(`${request.method()} ${url.pathname}`);
        if (request.postData() != null) out.push(`request body on ${url.pathname}`);
        if (url.origin !== origin) out.push(`third-party request ${url.origin}`);
        else if (!url.pathname.startsWith("/_next/static/")) out.push(`non-static request ${url.pathname}`);
        for (const id of IDENTIFIERS) {
          if (decodeURIComponent(request.url()).includes(id)) out.push(`identifier in a URL (${url.pathname})`);
        }
      }
      for (const line of consoleLines) {
        for (const id of IDENTIFIERS) if (line.includes(id)) out.push(`identifier in console: ${line.slice(0, 80)}`);
      }
      return out;
    },
    requestCount: () => after.length,
    wasmFetched: () => after.map((r) => r.url()).filter((u) => u.endsWith(".wasm")).map((u) => path.basename(u)),
  };
}

async function marks(page: Page) {
  return page.evaluate(() => {
    const all = performance.getEntriesByType("mark");
    const at = (name: string) => all.find((m) => m.name === name)?.startTime ?? null;
    const received = at("flowrad:viewer:files-received");
    const pixel = all.find((m) => m.name.startsWith("radlearn:first-pixel:") && m.startTime >= (received ?? 0));
    const ready = all.find((m) => m.name.startsWith("radlearn:series-ready:") && m.startTime >= (received ?? 0));
    return {
      received,
      firstRegistered: at("flowrad:viewer:first-image-registered"),
      parsed: at("flowrad:viewer:study-parsed"),
      firstPixel: pixel?.startTime ?? null,
      seriesReady: ready?.startTime ?? null,
    };
  });
}

async function centreLuma(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll("canvas")).filter((c) => c.width > 64);
    const c = canvases[0];
    if (!c) return 0;
    const probe = document.createElement("canvas");
    probe.width = probe.height = 32;
    const ctx = probe.getContext("2d")!;
    ctx.drawImage(c, c.width / 4, c.height / 4, c.width / 2, c.height / 2, 0, 0, 32, 32);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i]);
    return max;
  });
}

async function measureFirstImage(page: Page) {
  await expect.poll(async () => (await marks(page)).firstPixel, { timeout: 30_000, intervals: [25] }).not.toBeNull();
  await expect.poll(() => centreLuma(page), { timeout: 10_000, intervals: [25] }).toBeGreaterThan(30);
  const m = await marks(page);
  return {
    firstImageMs: Math.round(m.firstPixel! - m.received!),
    firstHeaderMs: m.firstRegistered != null ? Math.round(m.firstRegistered - m.received!) : null,
  };
}

async function waitParsed(page: Page) {
  await expect.poll(async () => (await marks(page)).seriesReady, { timeout: 60_000, intervals: [50] }).not.toBeNull();
  const m = await marks(page);
  return {
    allHeadersMs: m.parsed != null ? Math.round(m.parsed - m.received!) : null,
    seriesReadyMs: Math.round(m.seriesReady! - m.received!),
  };
}

/** Wheel through the stack at 60 Hz while sampling rAF intervals and long tasks in the page. */
async function measureScroll(page: Page, steps: number) {
  const canvas = page.locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    const w = window as unknown as { __perf: { frames: number[]; longTasks: number[]; stop: boolean } };
    w.__perf = { frames: [], longTasks: [], stop: false };
    let last = performance.now();
    const tick = (now: number) => {
      w.__perf.frames.push(now - last);
      last = now;
      if (!w.__perf.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__perf.longTasks.push(entry.duration);
      }).observe({ type: "longtask", buffered: false });
    } catch {
      /* longtask unsupported: frames still measured */
    }
  });
  const before = await centreLuma(page);
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, i < steps / 2 ? 120 : -120);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(250);
  const raw = await page.evaluate(() => {
    const w = window as unknown as { __perf: { frames: number[]; longTasks: number[]; stop: boolean } };
    w.__perf.stop = true;
    return { frames: w.__perf.frames.slice(1), longTasks: w.__perf.longTasks };
  });
  return {
    steps,
    frames: raw.frames.length,
    frameP50Ms: round(percentile(raw.frames, 50)),
    frameP95Ms: round(percentile(raw.frames, 95)),
    frameMaxMs: round(Math.max(0, ...raw.frames)),
    /** Share of frames slower than 60 fps (> 20 ms). */
    slowFrameShare: round((100 * raw.frames.filter((f) => f > 20).length) / Math.max(1, raw.frames.length)) / 100,
    longTasks: raw.longTasks.length,
    longestTaskMs: round(Math.max(0, ...raw.longTasks)),
    paintedBefore: before,
  };
}

async function gpuRenderer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
    if (!gl) return "no WebGL";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  });
}

async function viewerStats(page: Page) {
  return page.evaluate(async () => {
    const w = window as unknown as { __flowradViewerStats?: () => Promise<{ cacheBytes: number; maxCacheBytes: number; openFiles: number }> };
    return w.__flowradViewerStats ? w.__flowradViewerStats() : null;
  });
}

async function jsHeapMb(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const used = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
  return Math.round(used / 1024 / 1024);
}

/** Resident memory of the renderer + GPU processes (Linux /proc), MB. Null elsewhere. */
async function rendererRssMb(browser: Browser): Promise<number | null> {
  if (process.platform !== "linux") return null;
  try {
    const session = await browser.newBrowserCDPSession();
    const info = (await session.send("SystemInfo.getProcessInfo")) as {
      processInfo: { id: number; type: string }[];
    };
    await session.detach();
    let kb = 0;
    for (const p of info.processInfo) {
      if (p.type !== "renderer" && p.type !== "GPU") continue;
      const status = fs.readFileSync(`/proc/${p.id}/status`, "utf8");
      kb += Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
    }
    return Math.round(kb / 1024);
  } catch {
    return null;
  }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  if (fs.existsSync(OUT_FILE)) fs.rmSync(OUT_FILE);
});

test("public, no sign-in: /viewer renders the dropzone with the privacy line and Owl Scan brand", async ({ page }) => {
  const response = await page.goto("/viewer");
  expect(response?.status()).toBe(200);
  expect(page.url()).toMatch(/\/viewer$/); // no redirect to sign-in
  await expect(page.getByTestId("local-dropzone")).toBeVisible();
  await expect(page.getByText("Your images never leave your computer.").first()).toBeVisible();
  await expect(page.getByRole("img", { name: "FlowRad" })).toBeVisible();
  const svg = await page.request.get("/owlscan.svg");
  const master = fs.readFileSync(path.join(__dirname, "..", "..", "public", "owlscan.svg"));
  expect(Buffer.from(await svg.body()).equals(master), "the served icon is the master SVG").toBe(true);
  await page.screenshot({ path: path.join(OUT_DIR, "01-dropzone.png") });
});

test("CT 520 slices as a folder: first image, scroll, memory, privacy", async ({ page, browser }) => {
  test.skip(!CT_DIR, "TEST_CT_LARGE_DIR is not set (scripts/make-test-ct.py --slices 520)");
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const privacy = watchPrivacy(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto("/viewer");
  await expect(page.getByTestId("local-dropzone")).toBeVisible();
  // Let the idle prewarm (engine, decode + header workers, GL context) finish,
  // as it does in the seconds a user spends picking a folder.
  await page.waitForTimeout(2500);
  const rssIdle = await rendererRssMb(browser);

  privacy.arm();
  await page.locator("input[type=file][webkitdirectory]").setInputFiles(CT_DIR!);
  const first = await measureFirstImage(page);
  await page.screenshot({ path: path.join(OUT_DIR, "02-ct-first-image.png") });
  const parsed = await waitParsed(page);
  await expect(page.getByText("520 images").first()).toBeVisible();
  // Let the background fill run, then scroll the whole stack down and back.
  await page.waitForTimeout(3000);
  const scroll = await measureScroll(page, SCROLL_STEPS);
  const renderer = await gpuRenderer(page);
  const softwareGpu = /swiftshader|llvmpipe|software/i.test(renderer);
  await page.screenshot({ path: path.join(OUT_DIR, "03-ct-scrolled.png") });
  const stats = await viewerStats(page);
  const heapOpen = await jsHeapMb(cdp);
  const rssOpen = await rendererRssMb(browser);

  await page.getByRole("button", { name: "Close study" }).first().click();
  await expect(page.getByTestId("local-dropzone")).toBeVisible();
  await page.waitForTimeout(500);
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  await page.waitForTimeout(500);
  const statsClosed = await viewerStats(page);
  const heapClosed = await jsHeapMb(cdp);
  const rssClosed = await rendererRssMb(browser);
  const wasm = privacy.wasmFetched();
  const violations = privacy.violations();

  const result = {
    study: "CT 520 × 512² uncompressed (263 MB), folder",
    ...first,
    ...parsed,
    scroll: { ...scroll, gpu: renderer, softwareGpu, frameP95BudgetMs: softwareGpu ? FRAME_P95_SOFTWARE_GPU_BUDGET_MS : FRAME_P95_BUDGET_MS },
    memory: {
      cacheMb: stats ? Math.round(stats.cacheBytes / 1048576) : null,
      cacheCapMb: stats ? Math.round(stats.maxCacheBytes / 1048576) : null,
      cacheAfterCloseMb: statsClosed ? Math.round(statsClosed.cacheBytes / 1048576) : null,
      filesAfterClose: statsClosed?.openFiles ?? null,
      jsHeapOpenMb: heapOpen,
      jsHeapClosedMb: heapClosed,
      rendererRssIdleMb: rssIdle,
      rendererRssOpenMb: rssOpen,
      rendererRssClosedMb: rssClosed,
    },
    wasmFetched: wasm,
    requestsAfterDrop: privacy.requestCount(),
    privacyViolations: violations,
  };
  record("ct520", result);
  console.log(JSON.stringify(result, null, 2));

  expect(violations, "privacy: no data leaves the page").toEqual([]);
  expect(first.firstImageMs, "first image after drop").toBeLessThanOrEqual(FIRST_IMAGE_BUDGET_MS);
  expect(scroll.longestTaskMs, "no main-thread task over 50 ms while scrolling").toBeLessThanOrEqual(LONG_TASK_BUDGET_MS);
  expect(scroll.frameP95Ms, `p95 frame interval while scrolling (${renderer})`).toBeLessThanOrEqual(
    softwareGpu ? FRAME_P95_SOFTWARE_GPU_BUDGET_MS : FRAME_P95_BUDGET_MS
  );
  expect(wasm, "uncompressed CT must not load any WASM codec").toEqual([]);
  expect(statsClosed?.cacheBytes, "Close study frees the decoded cache").toBe(0);
  expect(statsClosed?.openFiles, "Close study drops every file handle").toBe(0);
});

test("memory cap: a 2 GB device scrolls all 520 slices under its cap (eviction), then frees on close", async ({ browser }) => {
  test.skip(!CT_DIR, "TEST_CT_LARGE_DIR is not set");
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "deviceMemory", { get: () => 2, configurable: true });
  });
  const page = await context.newPage();
  await page.goto("/viewer");
  await page.locator("input[type=file][webkitdirectory]").setInputFiles(CT_DIR!);
  await measureFirstImage(page);
  await waitParsed(page);
  let peak = 0;
  let cap = 0;
  // Scroll end to end, sampling the cache: it must evict, never exceed the cap.
  const canvas = page.locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < 540; i += 1) {
      await page.mouse.wheel(0, pass === 0 ? 120 : -120);
      if (i % 30 === 0) {
        const s = await viewerStats(page);
        if (s) {
          peak = Math.max(peak, s.cacheBytes);
          cap = s.maxCacheBytes;
        }
      }
    }
    await page.waitForTimeout(1500);
    const s = await viewerStats(page);
    if (s) peak = Math.max(peak, s.cacheBytes);
  }
  await expect.poll(() => centreLuma(page)).toBeGreaterThan(30); // still painting: the tab survived
  await page.getByRole("button", { name: "Close study" }).first().click();
  const closed = await viewerStats(page);
  record("memoryCap", {
    emulatedDeviceMemoryGb: 2,
    cacheCapMb: Math.round(cap / 1048576),
    cachePeakMb: Math.round(peak / 1048576),
    cacheAfterCloseMb: closed ? Math.round(closed.cacheBytes / 1048576) : null,
  });
  expect(cap).toBeGreaterThan(0);
  expect(peak, "decoded cache stays under the device cap").toBeLessThanOrEqual(cap);
  expect(closed?.cacheBytes).toBe(0);
  await context.close();
});

test("MR multi-series JPEG 2000 as a ZIP: first image, series switch, lazy codec, privacy", async ({ page }, testInfo) => {
  test.skip(!MR_DIR, "TEST_MR_DIR is not set (scripts/make-test-mr.py)");
  test.setTimeout(180_000);
  // A deflated ZIP like a PACS export, with a CD index and macOS noise inside.
  const zip = new AdmZip();
  zip.addLocalFolder(MR_DIR!, "BRAIN_MR");
  zip.addFile("BRAIN_MR/DICOMDIR", Buffer.from("index placeholder"));
  zip.addFile("__MACOSX/BRAIN_MR/._IM00001", Buffer.from("resource fork"));
  const zipPath = testInfo.outputPath("brain-mr.zip");
  zip.writeZip(zipPath);

  await page.setViewportSize({ width: 1440, height: 900 });
  const privacy = watchPrivacy(page);
  await page.goto("/viewer");
  await expect(page.getByTestId("local-dropzone")).toBeVisible();
  await page.waitForTimeout(2500);
  privacy.arm();
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(zipPath);
  const first = await measureFirstImage(page);
  const parsed = await waitParsed(page);
  const rail = page.getByRole("complementary", { name: "Series" });
  await expect(rail.locator("button[aria-pressed]")).toHaveCount(5);
  await page.screenshot({ path: path.join(OUT_DIR, "04-mr-zip.png") });

  // Switch series: a different series paints.
  const t0 = Date.now();
  await rail.getByRole("button", { name: /Sag T1/ }).click();
  await expect(rail.getByRole("button", { name: /Sag T1/ })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => centreLuma(page), { timeout: 10_000, intervals: [25] }).toBeGreaterThan(30);
  const switchMs = Date.now() - t0;
  await page.screenshot({ path: path.join(OUT_DIR, "05-mr-sagittal.png") });
  const wasm = privacy.wasmFetched();
  const violations = privacy.violations();
  const result = {
    study: "MR brain, 5 series / 216 images, JPEG 2000 lossless, deflated ZIP",
    ...first,
    ...parsed,
    seriesSwitchMs: switchMs,
    wasmFetched: wasm,
    requestsAfterDrop: privacy.requestCount(),
    privacyViolations: violations,
  };
  record("mrZip", result);
  console.log(JSON.stringify(result, null, 2));

  expect(violations, "privacy: no data leaves the page").toEqual([]);
  expect(first.firstImageMs, "first image after drop").toBeLessThanOrEqual(FIRST_IMAGE_BUDGET_MS);
  expect(wasm.length, "J2K loads its codec on demand").toBeGreaterThan(0);
  for (const name of wasm) expect(name, "only the codec this transfer syntax needs").toMatch(/^openjpeg/);
});
