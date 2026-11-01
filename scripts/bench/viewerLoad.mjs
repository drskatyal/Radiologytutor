#!/usr/bin/env node
// Real-viewer load benchmark: the shipped /case/[id]?mode=view page, in
// Chromium, over HTTP/2, against the phantom archive with production latency.
//
//   node scripts/bench/phantomOrthanc.mjs --port 8042 --slices 848 --matrix 512 \
//        --latency 620 --meta-pad 10000 --warm 1 --study <uid> --series <uid>
//   ORTHANC_URL=http://127.0.0.1:8042 DEMO_AUTH_ENABLED=1 npx next start -p 3123
//   node scripts/bench/h2proxy.mjs --port 8443 --target http://127.0.0.1:3123
//   node scripts/bench/viewerLoad.mjs --url https://127.0.0.1:8443 --case case-lidc-nodule-search \
//        --phantom http://127.0.0.1:8042 --slices 848 [--mpr 1] [--label before]
//
// Reports, from navigation start:
//   firstPixel  the corner overlay shows "Im n / N" (the opening frame painted)
//   allFrames   the archive has served every slice of the series at least once
//               (`--mpr 1` presses X after first pixel — the only way the old
//               viewer ever loads a whole series)
//   routes      archive requests by kind — duplicates show up here
//   browser     /api/dicomweb requests the page made, by kind, and X-Cache

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const URL_BASE = (args.get("url") ?? "https://127.0.0.1:8443").replace(/\/$/, "");
const CASE = args.get("case") ?? "case-lidc-nodule-search";
const PHANTOM = (args.get("phantom") ?? "http://127.0.0.1:8042").replace(/\/$/, "");
const SLICES = Number(args.get("slices") ?? 848);
const MPR = args.get("mpr") === "1";
const TIMEOUT_MS = Number(args.get("timeout") ?? 240_000);
const LABEL = args.get("label") ?? "run";
// Downlink cap in Mbit/s (Chrome network emulation). Production's 848-slice
// open took ~90 s for ~445 MB of uncompressed frames: ~40 Mbit/s effective.
const MBPS = Number(args.get("mbps") ?? 0);

const { chromium } = await import("playwright");

function kind(url) {
  const p = new URL(url).pathname;
  if (/\/frames\/\d+$/.test(p)) return "frame";
  if (/\/instances\/[^/]+\/metadata$/.test(p)) return "instance-metadata";
  if (/\/series\/[^/]+\/metadata$/.test(p)) return "series-metadata";
  if (/\/instances$/.test(p)) return new URL(url).searchParams.get("limit") === "1" ? "qido-1row" : "qido-list";
  if (/\/rendered$/.test(p)) return "rendered";
  return "other";
}

await fetch(`${PHANTOM}/phantom/stats`, { method: "POST" });
const { existsSync } = await import("node:fs");
const SYSTEM_CHROMIUM = process.env.BENCH_CHROMIUM ?? "/opt/pw-browsers/chromium";
const browser = await chromium.launch({
  ...(existsSync(SYSTEM_CHROMIUM) ? { executablePath: SYSTEM_CHROMIUM } : {}),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
await ctx.request.post(`${URL_BASE}/api/auth/demo`, { data: { role: "student" } });
const page = await ctx.newPage();
if (MBPS > 0) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: (MBPS * 1e6) / 8,
    uploadThroughput: (MBPS * 1e6) / 8,
  });
}

const browserReqs = {};
const uniqueFrames = new Set();
const xcache = {};
const errors = [];
const statusErrors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
page.on("response", (r) => {
  const u = r.url();
  if (r.status() >= 400) statusErrors.push(`${r.status()} ${new URL(u).pathname.slice(0, 90)}`);
  if (!u.includes("/api/dicomweb/")) return;
  const k = kind(u);
  browserReqs[k] = (browserReqs[k] ?? 0) + 1;
  if (k === "frame" && r.status() === 200) uniqueFrames.add(new URL(u).pathname);
  const c = r.headers()["x-cache"];
  if (c) xcache[`${k}:${c}`] = (xcache[`${k}:${c}`] ?? 0) + 1;
});

const t0 = Date.now();
await page.goto(`${URL_BASE}/case/${CASE}?mode=view`, { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForSelector(`text=/Im \\d+ \\/ ${SLICES}/`, { timeout: 120_000 });
const firstPixel = Date.now() - t0;

if (MPR) {
  const vp = page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
  await vp.click({ position: { x: 400, y: 300 } });
  await page.keyboard.press("x");
}

let allFrames = null;
let allFramesInBrowser = null;
let stats = null;
while (Date.now() - t0 < TIMEOUT_MS) {
  stats = await (await fetch(`${PHANTOM}/phantom/stats`)).json();
  if (allFrames == null && stats.frames >= SLICES) allFrames = stats.lastNewFrameAt - t0;
  // Warm server cache: the archive serves nothing, so also watch the page.
  if (allFramesInBrowser == null && uniqueFrames.size >= SLICES) allFramesInBrowser = Date.now() - t0;
  if ((allFrames != null || stats.frames === 0) && allFramesInBrowser != null) break;
  await new Promise((r) => setTimeout(r, 250));
}
await page.waitForTimeout(1500);
stats = await (await fetch(`${PHANTOM}/phantom/stats`)).json();

const result = {
  label: LABEL,
  slices: SLICES,
  mpr: MPR,
  mbps: MBPS || null,
  firstPixelMs: firstPixel,
  allFramesMs: allFrames,
  allFramesInBrowserMs: allFramesInBrowser,
  framesServed: stats.frames,
  frameRequests: stats.frameRequests,
  jlsFrames: stats.jlsFrames,
  frameMB: +(stats.bytesOut / 1e6).toFixed(1),
  archiveRoutes: stats.byRoute,
  browserRequests: browserReqs,
  xCache: xcache,
  httpErrors: [...new Set(statusErrors)].slice(0, 8),
  pageErrors: [...new Set(errors)].slice(0, 5),
};
console.log(JSON.stringify(result, null, 2));
await browser.close();
