#!/usr/bin/env node
// Whole-series transfer benchmark, in the browser, over HTTP/2, through the
// real /api/dicomweb proxy: list the series once, then fetch every frame with
// the Accept the Cornerstone loader sends, `--concurrency` at a time, under a
// `--mbps` downlink cap. This isolates the wire cost of "load the 848-slice
// CT" from rendering, so old and new proxies are compared on equal terms.
//
//   node scripts/bench/seriesFetch.mjs --url https://127.0.0.1:8443 \
//     --study <uid> --series <uid> --concurrency 24 --mbps 40 [--label x] [--repeat 1]
//
// `--repeat 1` fetches the series a second time in a fresh browser context
// (empty browser cache) — what a second reader sees once the server cache
// is warm.

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const BASE = (args.get("url") ?? "https://127.0.0.1:8443").replace(/\/$/, "");
const STUDY = args.get("study");
const SERIES = args.get("series");
const C = Number(args.get("concurrency") ?? 24);
const MBPS = Number(args.get("mbps") ?? 40);
const LABEL = args.get("label") ?? "run";
const REPEAT = args.get("repeat") === "1";

const { chromium } = await import("playwright");
const { existsSync } = await import("node:fs");
const SYSTEM_CHROMIUM = process.env.BENCH_CHROMIUM ?? "/opt/pw-browsers/chromium";
const browser = await chromium.launch(existsSync(SYSTEM_CHROMIUM) ? { executablePath: SYSTEM_CHROMIUM } : {});

async function once(pass) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.request.post(`${BASE}/api/auth/demo`, { data: { role: "student" } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/terms`, { waitUntil: "domcontentloaded" });
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
  const result = await page.evaluate(
    async ({ base, study, series, c }) => {
      const root = `${base}/api/dicomweb/studies/${study}/series/${series}`;
      const t0 = performance.now();
      const list = await (await fetch(`${root}/instances?includefield=00080018`, { headers: { Accept: "application/dicom+json" } })).json();
      const sops = list.map((r) => r["00080018"].Value[0]);
      const accept = "multipart/related; type=application/octet-stream; transfer-syntax=*";
      let next = 0;
      let bytes = 0;
      const cache = {};
      const syntax = {};
      let firstDone = 0;
      async function worker() {
        while (next < sops.length) {
          const i = next++;
          const r = await fetch(`${root}/instances/${sops[i]}/frames/1`, { headers: { Accept: accept }, cache: "no-store" });
          const b = await r.arrayBuffer();
          bytes += b.byteLength;
          const x = r.headers.get("x-cache") ?? "none";
          cache[x] = (cache[x] ?? 0) + 1;
          const s = r.headers.get("x-frame-syntax") ?? "n/a";
          syntax[s] = (syntax[s] ?? 0) + 1;
          if (!firstDone) firstDone = performance.now() - t0;
        }
      }
      await Promise.all(Array.from({ length: c }, worker));
      return { frames: sops.length, ms: Math.round(performance.now() - t0), firstFrameMs: Math.round(firstDone), mb: +(bytes / 1e6).toFixed(1), xCache: cache, syntax };
    },
    { base: BASE, study: STUDY, series: SERIES, c: C }
  );
  await ctx.close();
  return { pass, ...result };
}

const runs = [await once("cold")];
if (REPEAT) runs.push(await once("repeat"));
console.log(JSON.stringify({ label: LABEL, concurrency: C, mbps: MBPS || null, runs }, null, 2));
await browser.close();
