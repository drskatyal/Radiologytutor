#!/usr/bin/env node
// FlowRad Viewer benchmark harness.
//
//   node desktop/scripts/bench.mjs desktop <binary> <study-path> [--runs 5]
//   node desktop/scripts/bench.mjs coldstart <binary> [--runs 5]
//   node desktop/scripts/bench.mjs idle <binary> [--seconds 8]
//   node desktop/scripts/bench.mjs browser <study-folder> [--runs 3]   # the web "before" path
//
// `desktop` launches the real app with RADLEARN_BENCH=1 RADLEARN_BENCH_EXIT=1
// and the study on the command line; the renderer reports one JSON line
// (scan, first image painted, scan done) and the app exits. The first run is
// cold (empty scan cache); the rest are warm (cache hits). `coldstart` times
// process start → first painted start screen, measured in-process AND from the
// outside (spawn → report). `idle` sums RSS over the app's process tree (the
// WebView runs in child processes) after it settles. `browser` serves the
// built renderer and drives Chromium through the browser fallback, which is
// `lib/localDicomFiles.ts` — the same loader /viewer/local uses on the web.
//
// On Windows run from PowerShell with the .exe path; on Linux CI wrap in
// `xvfb-run -a`. Numbers are medians.

import { spawn, execFileSync } from "node:child_process";
import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const [mode, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? Number(rest[i + 1]) : fallback;
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));
const median = (xs) => {
  const s = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const r0 = (x) => (Number.isFinite(x) ? Math.round(x) : x);

function runApp(binary, args, env = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(binary, args, {
      env: { ...process.env, RADLEARN_BENCH: "1", RADLEARN_BENCH_EXIT: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    // Whole-tree memory: sampled every second, peak kept (private bytes).
    let peak = null;
    const sample = () => {
      try {
        const m = treeMemory(child.pid);
        if (!peak || m.privateMb > peak.privateMb) peak = m;
        return m;
      } catch {
        return null;
      }
    };
    const sampler = setInterval(sample, 1000);
    const timer = setTimeout(() => {
      clearInterval(sampler);
      child.kill("SIGKILL");
      reject(new Error(`timed out; output:\n${out}`));
    }, 120_000);
    child.stdout.on("data", (d) => {
      out += d;
      const line = out.split("\n").find((l) => l.startsWith("RADLEARN_BENCH "));
      if (line && !child.reported) {
        child.reported = true;
        const report = JSON.parse(line.slice("RADLEARN_BENCH ".length));
        report.externalMs = performance.now() - started;
        clearInterval(sampler);
        const atReport = sample();
        report.tree = atReport && { wsMb: atReport.wsMb, privateMb: atReport.privateMb, processes: atReport.processes.length };
        report.peakTree = peak && { wsMb: peak.wsMb, privateMb: peak.privateMb };
        clearTimeout(timer);
        child.once("exit", () => resolve(report));
        setTimeout(() => child.kill("SIGKILL"), 3000);
      }
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
  });
}

function appCacheDir() {
  const id = "app.flowrad.viewer";
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? "", id);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", id);
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), id);
}

async function benchDesktop(binary, study) {
  const runs = flag("runs", 5);
  const reports = [];
  for (let i = 0; i < runs; i += 1) {
    if (i === 0) rmSync(path.join(appCacheDir(), "scan"), { recursive: true, force: true });
    const report = await runApp(binary, [study]);
    reports.push(report);
    console.error(
      `run ${i + 1}${i === 0 ? " (cold cache)" : ""}: scan ${r0(report.rust?.totalMs)} ms (rust) · first series ${r0(report.firstSeriesHungMs)} ms · first image ${r0(report.firstImagePaintedMs)} ms · all ready ${r0(report.scanDoneMs)} ms · cache hits ${report.cacheHits}`
    );
  }
  const warm = reports.slice(1);
  const summary = {
    mode: "desktop",
    study,
    files: reports[0].files,
    images: reports[0].images,
    cold: {
      rustScanMs: r0(reports[0].rust?.totalMs),
      firstImageMs: r0(reports[0].firstImagePaintedMs),
      allReadyMs: r0(reports[0].scanDoneMs),
    },
    warm: {
      rustScanMs: r0(median(warm.map((r) => r.rust?.totalMs))),
      firstSeriesMs: r0(median(warm.map((r) => r.firstSeriesHungMs))),
      firstImageMs: r0(median(warm.map((r) => r.firstImagePaintedMs))),
      allReadyMs: r0(median(warm.map((r) => r.scanDoneMs))),
      engineInitMs: r0(median(warm.map((r) => r.engineInitMs))),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
}

async function benchColdStart(binary) {
  const runs = flag("runs", 5);
  const inProc = [];
  const external = [];
  for (let i = 0; i < runs; i += 1) {
    const report = await runApp(binary, []);
    inProc.push(report.firstPaintMs);
    external.push(report.externalMs);
    console.error(`run ${i + 1}: first paint ${r0(report.firstPaintMs)} ms in-process · ${r0(report.externalMs)} ms spawn→report`);
  }
  console.log(
    JSON.stringify(
      { mode: "coldstart", firstRunMs: r0(inProc[0]), medianMs: r0(median(inProc)), medianExternalMs: r0(median(external)) },
      null,
      2
    )
  );
}

/**
 * Memory of the app's WHOLE process tree (the webview runs in child
 * processes: WebView2's browser, GPU, renderer and utility processes on
 * Windows; WebKit's web and network processes on Linux).
 *   ws      — working set (Windows) / RSS (Linux), MB
 *   private — private bytes (Windows PrivatePageCount) / private dirty+clean (Linux), MB
 */
function treeMemory(pid) {
  if (process.platform === "win32") {
    const ps = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,CommandLine | ConvertTo-Json -Compress",
      ],
      { maxBuffer: 64 * 1024 * 1024 }
    ).toString();
    const rows = JSON.parse(ps);
    const kids = new Map();
    for (const r of rows) kids.set(r.ParentProcessId, [...(kids.get(r.ParentProcessId) ?? []), r]);
    const procs = [];
    const stack = rows.filter((r) => r.ProcessId === pid);
    while (stack.length) {
      const r = stack.pop();
      const type = /--type=([\w-]+)/.exec(r.CommandLine ?? "")?.[1] ?? (procs.length ? "browser" : "app");
      procs.push({ name: r.Name, type, wsMb: Math.round(r.WorkingSetSize / 1048576), privateMb: Math.round(Number(r.PrivatePageCount) / 1048576) });
      stack.push(...(kids.get(r.ProcessId) ?? []));
    }
    return { wsMb: procs.reduce((n, p) => n + p.wsMb, 0), privateMb: procs.reduce((n, p) => n + p.privateMb, 0), processes: procs };
  }
  const ps = execFileSync("ps", ["-e", "-o", "pid=,ppid=,comm="]).toString();
  const rows = ps.trim().split("\n").map((l) => l.trim().split(/\s+/));
  const kids = new Map();
  for (const [p, pp] of rows) kids.set(Number(pp), [...(kids.get(Number(pp)) ?? []), Number(p)]);
  const name = new Map(rows.map(([p, , c]) => [Number(p), c]));
  const procs = [];
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    let rss = 0, priv = 0;
    try {
      for (const line of execFileSync("cat", [`/proc/${p}/smaps_rollup`]).toString().split("\n")) {
        const [k, v] = line.split(":");
        const kb = parseInt(v, 10) || 0;
        if (k === "Rss") rss = kb;
        if (k === "Private_Clean" || k === "Private_Dirty") priv += kb;
      }
    } catch {
      /* exited */
    }
    procs.push({ name: name.get(p), wsMb: Math.round(rss / 1024), privateMb: Math.round(priv / 1024) });
    stack.push(...(kids.get(p) ?? []));
  }
  return { wsMb: procs.reduce((n, p) => n + p.wsMb, 0), privateMb: procs.reduce((n, p) => n + p.privateMb, 0), processes: procs };
}

async function benchIdle(binary) {
  const seconds = flag("seconds", 8);
  const child = spawn(binary, [], { stdio: "ignore", env: { ...process.env } });
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const mem = treeMemory(child.pid);
  child.kill("SIGKILL");
  console.log(JSON.stringify({ mode: "idle", afterSeconds: seconds, tree: mem }, null, 2));
}

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

async function benchBrowser(study) {
  const runs = flag("runs", 3);
  const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "dist");
  if (!existsSync(dist)) throw new Error("Build the renderer first: npm --prefix desktop run build");
  const types = { ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".html": "text/html" };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const file = path.join(dist, url.pathname === "/" ? "index.html" : url.pathname);
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // Resolved like CommonJS so a globally installed Playwright (NODE_PATH) works.
  const { chromium } = createRequire(import.meta.url)("playwright");
  const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
  const files = listFiles(study);
  const results = [];
  for (let i = 0; i < runs; i += 1) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/?bench`);
    await page.waitForSelector("text=Open a study");
    await page.evaluate(() => delete window.__radlearnBench);
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles(files);
    const report = await page.waitForFunction(() => window.__radlearnBench, null, { timeout: 120_000 }).then((h) => h.jsonValue());
    results.push(report);
    console.error(`run ${i + 1}: headers ${r0(report.scanDoneMs)} ms · first image ${r0(report.firstImagePaintedMs)} ms`);
    await page.close();
  }
  await browser.close();
  server.close();
  console.log(
    JSON.stringify(
      {
        mode: "browser",
        study,
        files: files.length,
        allHeadersMs: r0(median(results.map((r) => r.scanDoneMs))),
        firstImageMs: r0(median(results.map((r) => r.firstImagePaintedMs))),
      },
      null,
      2
    )
  );
}

const modes = {
  desktop: () => benchDesktop(positional[0], positional[1]),
  coldstart: () => benchColdStart(positional[0]),
  idle: () => benchIdle(positional[0]),
  browser: () => benchBrowser(positional[0]),
};
if (!modes[mode]) {
  console.error("usage: bench.mjs desktop|coldstart|idle|browser …  (see header)");
  process.exit(2);
}
await modes[mode]();
