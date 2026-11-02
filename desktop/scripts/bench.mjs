#!/usr/bin/env node
// FlowRad Viewer benchmark harness.
//
//   node desktop/scripts/bench.mjs desktop <binary> <study-path> [--runs 5] [--max-first-image-ms N]
//   node desktop/scripts/bench.mjs coldstart <binary> [--runs 5] [--max-ms N]
//   node desktop/scripts/bench.mjs interact <binary> <study-path> [--max-frame-p95-ms 16.7] [--max-dropped 0]
//   node desktop/scripts/bench.mjs idle <binary> [--seconds 8]
//   node desktop/scripts/bench.mjs browser <study-folder> [--runs 3]   # the web "before" path
//   node desktop/scripts/bench.mjs mpr <binary> <study-path> [--settle 6] [--max-mb 1200] [--max-ms N] [--max-settled-mb N]
//   (FLOWRAD_BENCH_VIEW=grid: the study open in 2D instead, i.e. idle memory with a study open)
//
// `desktop` launches the real app with FLOWRAD_BENCH=1 FLOWRAD_BENCH_EXIT=1
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

import { spawn, spawnSync, execFileSync } from "node:child_process";
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
// The app prints "FLOWRAD_BENCH {json}" (builds before 0.5.2: "RADLEARN_BENCH").
const REPORT = /^(FLOWRAD|RADLEARN)_BENCH /;
/** Bench switches under both names, so pre-0.5.2 builds can still be compared. */
const benchEnv = (vars) =>
  Object.fromEntries(Object.entries(vars).flatMap(([k, v]) => [[`FLOWRAD_${k}`, v], [`RADLEARN_${k}`, v]]));
const r0 = (x) => (Number.isFinite(x) ? Math.round(x) : x);

function runApp(binary, args, env = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(binary, args, {
      env: { ...process.env, ...benchEnv({ BENCH: "1", BENCH_EXIT: "1" }), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // The app's output: only a tail is kept (for the timeout message) and the
    // report line is found line by line. Keeping all of it re-split on every
    // chunk ran the bench out of heap on a 10k-file open.
    let out = "";
    let pending = "";
    let bytes = 0;
    const TAIL = 64 * 1024;
    const keep = (d) => {
      bytes += d.length;
      out = (out + d).slice(-TAIL);
    };
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
    }, Number(env.FLOWRAD_BENCH_TIMEOUT_MS ?? 120_000) + 5_000);
    child.stdout.on("data", (d) => {
      keep(d);
      pending += d;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (pending.length > TAIL && !REPORT.test(pending)) pending = "";
      const line = lines.find((l) => REPORT.test(l));
      if (line && !child.reported) {
        child.reported = true;
        const report = JSON.parse(line.replace(REPORT, ""));
        report.externalMs = performance.now() - started;
        report.appOutputKb = Math.round(bytes / 1024);
        if (bytes > 1 << 20) console.error(`note: the app wrote ${(bytes / 1048576).toFixed(1)} MB to stdout/stderr during this run`);
        clearInterval(sampler);
        const atReport = sample();
        report.tree = atReport && { wsMb: atReport.wsMb, privateMb: atReport.privateMb, processes: atReport.processes.length };
        report.peakTree = peak && { wsMb: peak.wsMb, privateMb: peak.privateMb };
        clearTimeout(timer);
        child.once("exit", () => resolve(report));
        setTimeout(() => child.kill("SIGKILL"), 3000);
      }
    });
    child.stderr.on("data", (d) => keep(d));
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
    if (i === 0) {
      rmSync(path.join(appCacheDir(), "scan"), { recursive: true, force: true });
      // A cold run reads from disk: drop the OS file cache too (elevated CI runners).
      const flush = spawnSync(process.platform === "win32" ? "python" : "python3", [path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "flush-file-cache.py")], { encoding: "utf8" });
      console.error(`run 1: ${(flush.stdout || flush.stderr || "file cache flush unavailable").trim()}`);
    }
    const report = await runApp(binary, [study]);
    reports.push(report);
    console.error(
      `run ${i + 1}${i === 0 ? " (cold cache)" : ""}: scan ${r0(report.rust?.totalMs)} ms (rust) · first series ${r0(report.firstSeriesHungMs)} ms · preview ${r0(report.paint?.firstPreviewMs)} ms · first image ${r0(report.firstImagePaintedMs)} ms · all ready ${r0(report.scanDoneMs)} ms · cache hits ${report.cacheHits} · long tasks max ${r0(report.longTasks?.maxMs)} ms ${(report.longTasks?.recent ?? []).map((t) => `${t.name}:${t.ms}`).join(", ")}`
    );
  }
  const warm = reports.slice(1);
  // The first slice on screen: Rust's instant preview (the full image at the
  // series window) or the engine's paint, whichever came first.
  const visible = (r) => Math.min(r.paint?.firstPreviewMs ?? Infinity, r.firstImagePaintedMs ?? Infinity);
  const summary = {
    mode: "desktop",
    study,
    files: reports[0].files,
    images: reports[0].images,
    cold: {
      rustScanMs: r0(reports[0].rust?.totalMs),
      firstImageMs: r0(reports[0].firstImagePaintedMs),
      firstVisibleMs: r0(visible(reports[0])),
      allReadyMs: r0(reports[0].scanDoneMs),
    },
    warm: {
      rustScanMs: r0(median(warm.map((r) => r.rust?.totalMs))),
      firstSeriesMs: r0(median(warm.map((r) => r.firstSeriesHungMs))),
      firstImageMs: r0(median(warm.map((r) => r.firstImagePaintedMs))),
      firstPreviewMs: r0(median(warm.map((r) => r.paint?.firstPreviewMs))),
      firstVisibleMs: r0(median(warm.map(visible))),
      maxLongTaskMs: r0(Math.max(...warm.map((r) => r.longTasks?.maxMs ?? 0))),
      allReadyMs: r0(median(warm.map((r) => r.scanDoneMs))),
      engineInitMs: r0(median(warm.map((r) => r.engineInitMs))),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  // Gate: warm first image (cold when only one run).
  const budget = flag("max-first-image-ms", Infinity);
  const firstImage = runs > 1 ? summary.warm.firstImageMs : summary.cold.firstImageMs;
  if (!(firstImage <= budget)) {
    console.error(`first-image gate failed: ${firstImage} ms > ${budget} ms`);
    process.exitCode = 1;
  }
  const visibleBudget = flag("max-first-visible-ms", Infinity);
  const firstVisible = runs > 1 ? summary.warm.firstVisibleMs : summary.cold.firstVisibleMs;
  if (!(firstVisible <= visibleBudget)) {
    console.error(`first-visible gate failed: ${firstVisible} ms > ${visibleBudget} ms`);
    process.exitCode = 1;
  }
}

async function benchColdStart(binary) {
  const runs = flag("runs", 5);
  const inProc = [];
  const external = [];
  const stages = { windowBuiltMs: [], navStartMs: [], jsStartMs: [], navDoneMs: [] };
  for (let i = 0; i < runs; i += 1) {
    const report = await runApp(binary, []);
    inProc.push(report.firstPaintMs);
    external.push(report.externalMs);
    for (const k of Object.keys(stages)) if (typeof report[k] === "number") stages[k].push(report[k]);
    console.error(
      `run ${i + 1}: first paint ${r0(report.firstPaintMs)} ms · window built ${r0(report.windowBuiltMs)} · page load start ${r0(report.navStartMs)} · JS start ${r0(report.jsStartMs)} · spawn→report ${r0(report.externalMs)} ms`
    );
  }
  // Where the time goes before first paint: Rust + window creation
  // (windowBuiltMs), WebView2 start until it begins loading the page
  // (navStartMs), page JS start, first paint.
  const breakdown = Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, v.length ? r0(median(v)) : null]));
  console.log(
    JSON.stringify(
      { mode: "coldstart", firstRunMs: r0(inProc[0]), medianMs: r0(median(inProc)), medianExternalMs: r0(median(external)), median: breakdown },
      null,
      2
    )
  );
  const budget = flag("max-ms", Infinity);
  if (!(median(inProc) <= budget)) {
    console.error(`cold-start gate failed: median first paint ${r0(median(inProc))} ms > ${budget} ms`);
    process.exitCode = 1;
  }
}

// Frame-time profile: open the study, then scroll 120 slices, zoom and drag
// window/level one step per frame (desktop/src/viewer/frameProfile.ts).
// Gate: input→render p95 within one 60 Hz frame and no dropped frames.
async function benchInteract(binary, study) {
  const maxP95 = flag("max-frame-p95-ms", Infinity);
  const maxDropped = flag("max-dropped", Infinity);
  const report = await runApp(binary, [study], benchEnv({ BENCH_VIEW: "interact" }));
  const i = report.interaction;
  if (!i) throw new Error("no interaction profile in the report");
  const summary = { mode: "interact", study, ...i };
  console.log(JSON.stringify(summary, null, 2));
  const over = [];
  for (const k of ["scroll", "zoom", "windowLevel"]) {
    if (i[k].p95 > maxP95) over.push(`${k} p95 ${i[k].p95} ms > ${maxP95} ms`);
  }
  if (i.frames.over33 > maxDropped) over.push(`${i.frames.over33} dropped frames (> 33 ms) > ${maxDropped}`);
  if (over.length) {
    console.error(`frame-time gate failed: ${over.join("; ")}`);
    process.exitCode = 1;
  }
}

/**
 * Multi-monitor: with a CT open, open a second viewer window (its own webview),
 * check it reports in, paints and follows the main window over the window
 * bus, close it, twice; the process tree is sampled before, during and after.
 *   --max-window-leak-mb N   after closing − baseline (memory back to baseline)
 *   --max-window-mb N        what one open window costs
 *   --max-long-tasks N       main-thread tasks over 50 ms during the run
 */
async function benchMultiWindow(binary, study) {
  const report = await runApp(binary, [study], benchEnv({ BENCH_VIEW: "multiwindow", BENCH_TIMEOUT_MS: String(240_000) }));
  const mw = report.multiWindow;
  if (!mw) throw new Error(`no multi-window report (marks: ${Object.keys(report).join(", ")}; timedOut: ${report.timedOut ?? "?"})`);
  console.log(JSON.stringify({ mode: "multiwindow", study, ...mw, longTasks: report.longTasks }, null, 2));
  const over = [];
  if (!mw.ok) over.push(`a window did not open / paint / follow: ${JSON.stringify(mw.runs)}`);
  const gate = (name, value, label) => {
    const max = flag(name, Infinity);
    if (value != null && value > max) over.push(`${label} ${value} > ${max}`);
  };
  gate("max-window-leak-mb", mw.leakMb, "MB not returned after closing the window");
  gate("max-window-mb", mw.perWindowMb, "MB per open window");
  gate("max-long-tasks", report.longTasks?.count ?? 0, "long tasks");
  if (over.length) {
    console.error(`multi-window gate failed: ${over.join("; ")}`);
    process.exitCode = 1;
  }
}

/**
 * Feature on/off leak test: CT open in 2D, every feature (MPR, 3D, cine,
 * tools, export, settings, PACS) opened and closed twice; the app samples its
 * whole process tree (working set) at baseline and after each round.
 *   --max-leak-mb N          final − baseline
 *   --max-round-growth-mb N  last round − first round (a steady leak)
 *   --max-idle-mb N          baseline (CT open, idle) — the 400 MB target
 *   --max-long-tasks N       main-thread tasks over 50 ms during the run
 *   --rounds N               open/close cycles (default 2; FLOWRAD_LEAK_ROUNDS)
 */
async function benchLeak(binary, study) {
  const report = await runApp(binary, [study], benchEnv({ BENCH_VIEW: "leak", BENCH_TIMEOUT_MS: String(120_000 + 40_000 * flag("rounds", 2)), LEAK_ROUNDS: String(flag("rounds", 2)) }));
  const leak = report.leak;
  if (!leak) throw new Error("no leak report");
  console.log(JSON.stringify({ mode: "leak", study, ...leak, longTasks: report.longTasks ?? leak.longTasks }, null, 2));
  const over = [];
  const gate = (name, value, label) => {
    const max = flag(name, Infinity);
    if (value > max) over.push(`${label} ${value} > ${max}`);
  };
  gate("max-leak-mb", leak.leakMb, "leak MB");
  gate("max-round-growth-mb", leak.roundGrowthMb, "round-over-round growth MB");
  gate("max-idle-mb", leak.baselineMb, "idle MB (CT open)");
  gate("max-long-tasks", (report.longTasks ?? leak.longTasks)?.count ?? 0, "long tasks");
  if (over.length) {
    console.error(`leak gate failed: ${over.join("; ")}`);
    process.exitCode = 1;
  }
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
    // Windows reuses PIDs, so a stale ParentProcessId can point back into
    // the tree and make a cycle: without `seen` the walk never ended and ran
    // the bench out of heap (perf-windows, cold 10k-file MRI open).
    const seen = new Set();
    const stack = rows.filter((r) => r.ProcessId === pid);
    while (stack.length) {
      const r = stack.pop();
      if (seen.has(r.ProcessId)) continue;
      seen.add(r.ProcessId);
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
  const browser = await chromium.launch({
    // PW_CHROMIUM: a preinstalled Chromium when the pinned Playwright has no browser of its own.
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
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

// MPR: open the study straight into MPR (FLOWRAD_BENCH_VIEW=mpr), sample the
// whole process tree every 250 ms through the build AND for --settle seconds
// after the volume is ready (the texture upload lands after the report), and
// report build time, peak and settled private memory, per process.
// --max-mb / --max-ms turn it into a gate: exit 1 when exceeded.
async function benchMpr(binary, study) {
  const settle = flag("settle", 6);
  const maxMb = flag("max-mb", Infinity);
  const maxMs = flag("max-ms", Infinity);
  const maxSettledMb = flag("max-settled-mb", Infinity);
  const started = performance.now();
  const child = spawn(binary, [study], {
    env: { ...process.env, ...benchEnv({ BENCH: "1", BENCH_VIEW: process.env.FLOWRAD_BENCH_VIEW ?? process.env.RADLEARN_BENCH_VIEW ?? "mpr" }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let peak = null;
  let report = null;
  const timeline = [];
  const sample = () => {
    try {
      const m = treeMemory(child.pid);
      if (!peak || m.privateMb > peak.privateMb) peak = m;
      timeline.push([Math.round(performance.now() - started), m.privateMb, report ? 1 : 0]);
      return m;
    } catch {
      return null;
    }
  };
  const sampler = setInterval(sample, 250);
  child.stdout.on("data", (d) => {
    out += d;
    const line = out.split("\n").find((l) => REPORT.test(l));
    if (line && !report) report = JSON.parse(line.replace(REPORT, ""));
  });
  child.stderr.on("data", (d) => (out += d));
  const deadline = started + 180_000;
  while (!report && performance.now() < deadline && child.exitCode == null) await new Promise((r) => setTimeout(r, 100));
  if (!report) {
    clearInterval(sampler);
    child.kill("SIGKILL");
    throw new Error(`no MPR report; output:\n${out.slice(-2000)}`);
  }
  await new Promise((r) => setTimeout(r, settle * 1000));
  const settled = sample();
  clearInterval(sampler);
  child.kill("SIGKILL");
  const summary = {
    mode: "mpr",
    study,
    images: report.images,
    volumeLoadedMs: r0(report.volumeLoadedMs),
    volumeBuildMs: r0(report.volumeBuildMs),
    peakPrivateMb: peak?.privateMb,
    settledPrivateMb: settled?.privateMb,
    imageCacheMb: report.imageCacheMb ?? null,
    trimmedMb: report.trimmedMb ?? null,
    trim: report.trim ?? null,
    jsHeapMb: report.jsHeapMb ?? null,
    gpu: report.gpu ?? null,
    peakByProcess: peak?.processes.filter((p) => p.privateMb > 20),
    ...(process.env.BENCH_TIMELINE ? { timeline } : {}),
  };
  console.log(JSON.stringify(summary, null, 2));
  const over = [];
  if (summary.peakPrivateMb > maxMb) over.push(`peak ${summary.peakPrivateMb} MB > ${maxMb} MB`);
  if (summary.volumeLoadedMs > maxMs) over.push(`build ${summary.volumeLoadedMs} ms > ${maxMs} ms`);
  if (summary.settledPrivateMb > maxSettledMb) over.push(`settled ${summary.settledPrivateMb} MB > ${maxSettledMb} MB`);
  if (over.length) {
    console.error(`MPR gate failed: ${over.join("; ")}`);
    process.exitCode = 1;
  }
}

const modes = {
  interact: () => benchInteract(positional[0], positional[1]),
  leak: () => benchLeak(positional[0], positional[1]),
  multiwindow: () => benchMultiWindow(positional[0], positional[1]),
  mpr: () => benchMpr(positional[0], positional[1]),
  desktop: () => benchDesktop(positional[0], positional[1]),
  coldstart: () => benchColdStart(positional[0]),
  idle: () => benchIdle(positional[0]),
  browser: () => benchBrowser(positional[0]),
};
if (!modes[mode]) {
  console.error("usage: bench.mjs desktop|coldstart|idle|browser|mpr|interact|leak|multiwindow …  (see header)");
  process.exit(2);
}
await modes[mode]();
