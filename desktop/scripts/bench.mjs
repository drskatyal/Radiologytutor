#!/usr/bin/env node
// FlowRad Viewer benchmark harness.
//
//   node desktop/scripts/bench.mjs desktop <binary> <study-path> [--runs 5] [--max-first-image-ms N]
//   node desktop/scripts/bench.mjs coldstart <binary> [--runs 5] [--max-ms N] [--max-app-ms N]
//   node desktop/scripts/bench.mjs interact <binary> <study-path> [--max-frame-p95-ms 16.7] [--max-dropped 0]
//   node desktop/scripts/bench.mjs idle <binary> [--seconds 8]
//   node desktop/scripts/bench.mjs native <binary> <study-path> [--runs 3]   # Phase 2 native renderer
//   node desktop/scripts/bench.mjs browser <study-folder> [--runs 3]   # the web "before" path
//   node desktop/scripts/bench.mjs mpr <binary> <study-path> [--settle 6] [--max-mb 1200] [--max-ms N] [--max-settled-mb N]
//   (FLOWRAD_BENCH_VIEW=grid: the study open in 2D instead, i.e. idle memory with a study open;
//    --max-settled-private-mb / --max-peak-private-mb gate private bytes)
//   node desktop/scripts/bench.mjs close <binary> <study-path> [--settle 20] [--after-close 30]
//        [--max-baseline-private-mb N] [--max-open-private-mb N] [--max-close-delta-mb 30]
//
// `desktop` launches the real app with FLOWRAD_BENCH=1 FLOWRAD_BENCH_EXIT=1
// and the study on the command line; the renderer reports one JSON line
// (scan, first image painted, scan done) and the app exits. The first run is
// cold (empty scan cache); the rest are warm (cache hits). `coldstart` times
// process start → first visible frame, measured in-process AND from the
// outside (spawn → report). First visible = whichever reaches the screen
// first: the native splash (Windows: GDI, the same splash as the page's,
// timed once DWM has composed it; src-tauri/src/splash.rs) or the page's
// first contentful paint. --max-ms gates first visible; --max-app-ms gates
// the page's own share as before. `idle` sums RSS over the app's process tree (the
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
  // CI runners render with WARP (software D3D): the JS renderer's GPU path
  // intermittently falls back to the CPU there, and its one-time engine
  // start sometimes runs long. With FLOWRAD_BENCH_WARP_RETRY=1 (CI only) a run
  // that trips the render-path or long-task gate is DISCARDED and repeated
  // (at most twice per run), and every discard is logged. Thresholds do not
  // change and a run is never passed because of a retry: the gates judge the
  // repeated run, and a third strike still fails. The HP has no retries.
  const warpRetry = process.env.FLOWRAD_BENCH_WARP_RETRY === "1";
  const taskBudgetForRetry = flag("max-long-task-ms", Infinity);
  const discarded = [];
  const violation = (r) => {
    if (rest.includes("--require-gpu") && r.viewport?.renderPath && !["gpu", "native"].includes(r.viewport.renderPath)) return `render path ${r.viewport.renderPath}`;
    if ((r.longTasks?.maxMs ?? 0) > taskBudgetForRetry) return `long task ${r0(r.longTasks.maxMs)} ms (${(r.longTasks.recent ?? []).map((t) => `${t.name}:${t.ms}`).join(", ")})`;
    return null;
  };
  for (let i = 0; i < runs; i += 1) {
    let report;
    for (let attempt = 0; ; attempt += 1) {
      if (i === 0) {
        rmSync(path.join(appCacheDir(), "scan"), { recursive: true, force: true });
        // A cold run reads from disk: drop the OS file cache too (elevated CI runners).
        const flush = spawnSync(process.platform === "win32" ? "python" : "python3", [path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "flush-file-cache.py")], { encoding: "utf8" });
        console.error(`run 1: ${(flush.stdout || flush.stderr || "file cache flush unavailable").trim()}`);
      }
      report = await runApp(binary, [study]);
      const why = warpRetry ? violation(report) : null;
      if (!why || attempt >= 2) break;
      discarded.push({ run: i + 1, attempt: attempt + 1, why });
      console.error(`run ${i + 1}: DISCARDED (attempt ${attempt + 1} of 3, WARP runner): ${why}; repeating the run`);
    }
    // First image: the first full-resolution slice on screen at the file's
    // window: Rust's preview when it is full-res (the engine then repaints the
    // same pixels), else the engine's paint. The engine paint stays reported.
    report.enginePaintMs = report.firstImagePaintedMs;
    report.firstImageSource = report.firstFullResMs != null && !(report.firstImagePaintedMs < report.firstFullResMs) ? "full-res preview" : "engine";
    report.firstImageMs = Math.min(report.firstFullResMs ?? Infinity, report.firstImagePaintedMs ?? Infinity);
    if (!Number.isFinite(report.firstImageMs)) report.firstImageMs = null;
    reports.push(report);
    console.error(
      `run ${i + 1}${i === 0 ? " (cold cache)" : ""}: scan ${r0(report.rust?.totalMs)} ms (rust) · first series ${r0(report.firstSeriesHungMs)} ms · preview ${r0(report.paint?.firstPreviewMs)} ms · first image ${r0(report.firstImageMs)} ms (${report.firstImageSource}; engine paint ${r0(report.enginePaintMs)} ms) · all ready ${r0(report.scanDoneMs)} ms · cache hits ${report.cacheHits} · render ${report.viewport?.renderPath ?? "?"}${report.native?.initMs != null ? ` (native init ${r0(report.native.initMs)} ms${report.native.surfaceWaitMs != null ? `, main-thread wait ${r0(report.native.surfaceWaitMs)}` : ""})` : ""} · engine ${r0(report.engineInitMs)} ms (start ${r0(report.engineStartMs)}, ready ${r0(report.engineReadyMs)}) · long tasks max ${r0(report.longTasks?.maxMs)} ms ${(report.longTasks?.recent ?? []).map((t) => `${t.name}:${t.ms}`).join(", ")}`
    );
    // The open on one clock (ms after the open; the scan command's marks come
    // from the process clock): where a late first series spent its time.
    const at = report.openAtProcessMs;
    const rs = report.rust ?? {};
    if (at != null && rs.enteredAtMs != null) {
      const rel = (x) => (x == null ? "?" : r0(x - at));
      console.error(
        `  open timeline: open at ${r0(at)} ms after process start · scan called ${r0(report.scanCalledMs)} · Rust entered ${rel(rs.enteredAtMs)} · first batch sent ${rel(rs.firstBatchAtMs)} · scan returned ${rel(rs.doneAtMs)} · first batch received ${r0(report.firstHeaderMs)} · first series hung ${r0(report.firstSeriesHungMs)}`
      );
    }
  }
  if (discarded.length) console.error(`${discarded.length} run(s) discarded and repeated on the WARP runner: ${JSON.stringify(discarded)}`);
  const warm = reports.slice(1);
  // The first slice on screen: Rust's instant preview (the full image at the
  // series window) or the engine's paint, whichever came first.
  const visible = (r) => Math.min(r.paint?.firstPreviewMs ?? Infinity, r.firstImagePaintedMs ?? Infinity);
  const summary = {
    mode: "desktop",
    warpDiscarded: discarded,
    study,
    files: reports[0].files,
    images: reports[0].images,
    cold: {
      rustScanMs: r0(reports[0].rust?.totalMs),
      firstImageMs: r0(reports[0].firstImageMs),
      enginePaintMs: r0(reports[0].enginePaintMs),
      firstVisibleMs: r0(visible(reports[0])),
      allReadyMs: r0(reports[0].scanDoneMs),
    },
    warm: {
      rustScanMs: r0(median(warm.map((r) => r.rust?.totalMs))),
      firstSeriesMs: r0(median(warm.map((r) => r.firstSeriesHungMs))),
      firstImageMs: r0(median(warm.map((r) => r.firstImageMs))),
      enginePaintMs: r0(median(warm.map((r) => r.enginePaintMs))),
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
  // One-time open / start-up tasks (engine start, first render, series list),
  // every run cold and warm: the slowest main-thread task.
  const taskBudget = flag("max-long-task-ms", Infinity);
  const slowestTask = Math.max(...reports.map((r) => r.longTasks?.maxMs ?? 0));
  if (!(slowestTask <= taskBudget)) {
    console.error(`long-task gate failed: ${r0(slowestTask)} ms > ${taskBudget} ms (${reports.flatMap((r) => r.longTasks?.recent ?? []).map((t) => `${t.name}:${t.ms}`).join(", ")})`);
    process.exitCode = 1;
  }
  // The GPU path must paint: a CPU fallback means it drew blank.
  if (rest.includes("--require-gpu")) {
    // "native": the Phase 2 renderer (wgpu), a GPU path by construction.
    const fell = reports.map((r, i) => [i + 1, r.viewport?.renderPath]).filter(([, p]) => p && p !== "gpu" && p !== "native");
    if (fell.length) {
      console.error(`render-path gate failed: ${fell.map(([n, p]) => `run ${n} ${p}`).join(", ")}`);
      process.exitCode = 1;
    }
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
  const visible = [];
  const native = [];
  const external = [];
  const stages = { windowBuiltMs: [], webviewBuiltMs: [], navStartMs: [], jsStartMs: [], navDoneMs: [] };
  const appShare = [];
  const webviewShare = [];
  for (let i = 0; i < runs; i += 1) {
    const report = await runApp(binary, []);
    inProc.push(report.firstPaintMs);
    // What the reader sees first. The native splash counts only when the app
    // reports it composed on screen (nativeFirstPaintMs, splash.rs).
    const nativeMs = typeof report.nativeFirstPaintMs === "number" ? report.nativeFirstPaintMs : Infinity;
    if (Number.isFinite(nativeMs)) native.push(nativeMs);
    visible.push(Math.min(nativeMs, report.firstPaintMs));
    if (typeof report.navStartMs === "number" && typeof report.windowBuiltMs === "number") {
      appShare.push(report.windowBuiltMs + (report.firstPaintMs - report.navStartMs));
      webviewShare.push(report.navStartMs - report.windowBuiltMs);
    }
    external.push(report.externalMs);
    for (const k of Object.keys(stages)) if (typeof report[k] === "number") stages[k].push(report[k]);
    console.error(
      `run ${i + 1}: first visible ${r0(visible[visible.length - 1])} ms · page first paint ${r0(report.firstPaintMs)} ms · app built ${r0(report.windowBuiltMs)} · webview built ${r0(report.webviewBuiltMs)} · page load start ${r0(report.navStartMs)} · JS start ${r0(report.jsStartMs)} · spawn→report ${r0(report.externalMs)} ms${report.nativeFirstPaintMs != null ? ` · native first paint (${report.nativeFirstPaintSource ?? "native"}) ${r0(report.nativeFirstPaintMs)} ms` : " · no native first paint"}`
    );
    // The page's share, from its navigation start: what arrived when, and
    // what the first paint waited for.
    const pt = report.pageTiming;
    if (pt) console.error(`  page: html ${pt.html} · css ${pt.css} · entry js ${pt.js} · parsed ${pt.interactive} · DOMContentLoaded ${pt.dcl} · load ${pt.load} · first paint ${pt.fcp} ms`);
  }
  // Where the time goes before the page's first paint: Rust + Tauri's build
  // (windowBuiltMs: the app is built; the window itself is created when the
  // event loop starts), main window + webview built (webviewBuiltMs), WebView2
  // start until it begins loading the page (navStartMs), page JS start, first
  // paint.
  const breakdown = Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, v.length ? r0(median(v)) : null]));
  // Split the total into the two parts with different owners:
  //   webview2Ms  window built → WebView2 starts loading our page (the runtime's
  //               own start-up; ~0.4 s on the CI runner, ~1.2 s on the HP)
  //   appMs       window build + page load start → first paint (our code)
  const appMs = r0(median(appShare));
  const webview2Ms = r0(median(webviewShare));
  console.log(
    JSON.stringify(
      {
        mode: "coldstart",
        // First visible: native splash or page paint, whichever came first (gated).
        firstVisibleMs: r0(median(visible)),
        firstRunVisibleMs: r0(visible[0]),
        nativeFirstPaintMs: native.length ? r0(median(native)) : null,
        nativeRuns: native.length,
        // The page's own first paint (as before 0.8.3).
        firstRunMs: r0(inProc[0]),
        medianMs: r0(median(inProc)),
        medianExternalMs: r0(median(external)),
        appMs,
        webview2Ms,
        median: breakdown,
      },
      null,
      2
    )
  );
  const budget = flag("max-ms", Infinity);
  if (!(median(visible) <= budget)) {
    console.error(
      `cold-start gate failed: median first visible ${r0(median(visible))} ms > ${budget} ms (native first paint ${native.length ? `${r0(median(native))} ms in ${native.length}/${runs} runs` : "none"}, page first paint ${r0(median(inProc))} ms)`
    );
    process.exitCode = 1;
  }
  const appBudget = flag("max-app-ms", Infinity);
  if (appBudget !== Infinity && !(appMs <= appBudget)) {
    console.error(`cold-start gate failed: the app's own share ${appMs} ms > ${appBudget} ms (WebView2 start-up ${webview2Ms} ms not counted)`);
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
  // Freeze during interaction: the slowest single step of scroll, zoom, W/L.
  const maxStep = flag("max-interaction-ms", Infinity);
  const slowest = Math.max(i.frames.max ?? 0, ...["scroll", "zoom", "windowLevel"].map((k) => i[k].max ?? 0));
  const where = i.slowest ? ` (${i.slowest.kind} step ${i.slowest.step}: Rust ${i.slowest.rustMs} ms = decode ${i.slowest.decodeMs} + frame ${i.slowest.frameMs}${i.slowest.acquireMs != null ? `, of which waiting for a drawable ${i.slowest.acquireMs}` : ""})` : "";
  if (slowest > maxStep) over.push(`slowest interaction step ${slowest} ms > ${maxStep} ms${where}`);
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
 *   --max-long-tasks N       main-thread tasks over 50 ms while windows open and close
 */
async function benchMultiWindow(binary, study) {
  const report = await runApp(binary, [study], benchEnv({ BENCH_VIEW: "multiwindow", BENCH_TIMEOUT_MS: String(240_000) }));
  const mw = report.multiWindow;
  if (!mw) throw new Error(`no multi-window report (marks: ${Object.keys(report).join(", ")}; timedOut: ${report.timedOut ?? "?"})`);
  // mw.longTasks: during the window cycle only; startupLongTasks: the whole run.
  console.log(JSON.stringify({ mode: "multiwindow", study, ...mw, startupLongTasks: report.longTasks }, null, 2));
  const over = [];
  if (!mw.ok) over.push(`a window did not open / paint / follow: ${JSON.stringify(mw.runs)}`);
  const gate = (name, value, label) => {
    const max = flag(name, Infinity);
    if (value != null && value > max) over.push(`${label} ${value} > ${max}`);
  };
  gate("max-window-leak-mb", mw.leakMb, "MB not returned after closing the window");
  gate("max-window-mb", mw.perWindowMb, "MB per open window");
  gate("max-long-tasks", (mw.longTasks ?? report.longTasks)?.count ?? 0, "long tasks while opening/closing windows");
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
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,CommandLine,@{n='Created';e={if ($_.CreationDate) { [long]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds } else { 0 }}} | ConvertTo-Json -Compress",
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
      // A real child is never older than its parent. Windows reuses PIDs, so
      // processes whose (long-dead) parent had this PID would otherwise be
      // counted as the app's: perf-windows once summed 135 system processes
      // (lsass, svchost, Defender…) into "the app's tree", 3.7 GB.
      const born = Number(r.Created) || 0;
      stack.push(...(kids.get(r.ProcessId) ?? []).filter((c) => !born || !Number(c.Created) || Number(c.Created) >= born - 1000));
    }
    return { wsMb: procs.reduce((n, p) => n + p.wsMb, 0), privateMb: procs.reduce((n, p) => n + p.privateMb, 0), processes: procs };
  }
  if (process.platform === "darwin") return treeMemoryMac(pid);
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

/** "[[dd-]hh:]mm:ss" (ps etime) → seconds. */
function etimeSeconds(t) {
  const [d, rest] = t.includes("-") ? t.split("-") : ["0", t];
  return rest.split(":").map(Number).reduce((a, n) => a * 60 + n, 0) + Number(d) * 86400;
}

/** top's MEM column ("123M", "1.2G", "512K", "40M+") → MB. */
function topMb(v) {
  const m = /^([\d.]+)([KMGB]?)/.exec(v ?? "");
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2] === "G" ? n * 1024 : m[2] === "K" ? n / 1024 : m[2] === "B" ? n / 1048576 : n;
}

/**
 * macOS: WKWebView's WebContent / GPU / Networking processes are XPC
 * services started by launchd (parent pid 1), not children of the app, so a
 * parent walk misses them. The tree is the app, its descendants, and every
 * com.apple.WebKit.* process started after it (CI runners run nothing else on
 * WebKit). "private" is the physical footprint (top's MEM, what Activity
 * Monitor shows); "ws" is RSS.
 */
function treeMemoryMac(pid) {
  const rows = [];
  for (const line of execFileSync("ps", ["-axo", "pid=,ppid=,etime=,rss=,comm="]).toString().split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), age: etimeSeconds(m[3]), rssKb: Number(m[4]), comm: m[5] });
  }
  const app = rows.find((r) => r.pid === pid);
  if (!app) return { wsMb: 0, privateMb: 0, processes: [] };
  const kids = new Map();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  const tree = [];
  const stack = [app];
  const seen = new Set();
  while (stack.length) {
    const r = stack.pop();
    if (seen.has(r.pid)) continue;
    seen.add(r.pid);
    tree.push(r);
    stack.push(...(kids.get(r.pid) ?? []));
  }
  for (const r of rows) if (!seen.has(r.pid) && /com\.apple\.WebKit\./.test(r.comm) && r.age <= app.age + 2) tree.push(r);
  const footprint = new Map();
  try {
    const args = ["-l", "1", "-s", "0", "-stats", "pid,mem"];
    for (const r of tree) args.push("-pid", String(r.pid));
    for (const line of execFileSync("top", args, { encoding: "utf8" }).split("\n")) {
      const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
      if (m) footprint.set(Number(m[1]), topMb(m[2]));
    }
  } catch {
    /* top unavailable: fall back to RSS */
  }
  const kind = (r) =>
    r.pid === pid ? "app" : /WebContent/.test(r.comm) ? "renderer" : /GPU/.test(r.comm) ? "gpu-process" : /Networking/.test(r.comm) ? "utility" : "child";
  const procs = tree.map((r) => {
    const wsMb = Math.round(r.rssKb / 1024);
    return { pid: r.pid, name: path.basename(r.comm), type: kind(r), wsMb, privateMb: Math.round(footprint.get(r.pid) ?? wsMb) };
  });
  return { wsMb: procs.reduce((n, p) => n + p.wsMb, 0), privateMb: procs.reduce((n, p) => n + p.privateMb, 0), processes: procs };
}

/**
 * macOS: a process's footprint by category (`footprint`: dirty MB per memory
 * kind: MALLOC_*, IOSurface, IOAccelerator, WebKit / JavaScriptCore, …), so a
 * close delta names what stayed. Null where `footprint` cannot read the
 * process.
 */
function footprintCategories(pid) {
  if (process.platform !== "darwin" || !pid) return null;
  const mb = (v) => {
    const m = /^([\d.]+)\s*([KMG]?)B$/.exec(v.trim());
    return m ? Number(m[1]) * ({ "": 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 }[m[2]]) : NaN;
  };
  for (const cmd of [["sudo", ["-n", "/usr/bin/footprint", String(pid)]], ["/usr/bin/footprint", [String(pid)]]]) {
    try {
      const out = execFileSync(cmd[0], cmd[1], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 });
      const cats = {};
      for (const line of out.split("\n")) {
        // "  20 MB   0 B   0 B   150   MALLOC_SMALL": dirty, clean, reclaimable, regions, category.
        const m = /^\s*([\d.]+ ?[KMG]?B)\s+([\d.]+ ?[KMG]?B)\s+([\d.]+ ?[KMG]?B)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (m && m[5] !== "TOTAL") cats[m[5]] = Math.round(mb(m[1]) * 10) / 10;
      }
      if (Object.keys(cats).length) return cats;
    } catch {
      /* not permitted / not installed: try the next way */
    }
  }
  return null;
}

/** The categories that moved most between two footprints (MB, signed). */
function footprintDelta(a, b, top = 8) {
  if (!a || !b) return "unavailable";
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const d = [...keys].map((k) => [k, Math.round(((b[k] ?? 0) - (a[k] ?? 0)) * 10) / 10]).filter(([, v]) => Math.abs(v) >= 0.5);
  d.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  return d.length ? d.slice(0, top).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(", ") : "no category moved by 0.5 MB";
}

async function benchIdle(binary) {
  const seconds = flag("seconds", 8);
  const child = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  let out = "";
  const keep = (d) => (out = (out + d).slice(-8000));
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const exited = child.exitCode != null;
  const mem = treeMemory(child.pid);
  child.kill("SIGKILL");
  // A dead app measures 0 MB: that is a failure, not a floor.
  if (exited || mem.processes.length === 0) {
    console.error(`idle: the app is not running after ${seconds} s (exit ${child.exitCode}); its output:\n${out}`);
    process.exitCode = 1;
    return;
  }
  // The app's own process vs the webview's (browser, renderer, GPU, utility):
  // the WebView2 UI floor is the second number (docs/NATIVE_RENDERER.md, P2.0).
  const app = mem.processes[0];
  const webviewWs = mem.wsMb - (app?.wsMb ?? 0);
  const view = process.env.FLOWRAD_BENCH_VIEW ?? "start screen";
  console.error(
    `IDLE (${view}${process.env.FLOWRAD_NATIVE === "1" ? ", native" : ""}): whole tree ${mem.wsMb} MB working set (private ${mem.privateMb}) · app ${app?.wsMb ?? "?"} MB · webview ${webviewWs} MB · ${mem.processes.length} processes: ${mem.processes.map((p) => `${p.type ?? p.name} ${p.wsMb}`).join(", ")}`
  );
  console.log(JSON.stringify({ mode: "idle", view, afterSeconds: seconds, appWsMb: app?.wsMb ?? null, webviewWsMb: webviewWs, tree: mem }, null, 2));
  console.error(`IDLE private by process: ${mem.processes.map((p) => `${p.type ?? p.name} ${p.privateMb}`).join(", ")}`);
  const maxPrivate = flag("max-private-mb", Infinity);
  if (mem.privateMb > maxPrivate) {
    console.error(`idle gate failed: whole tree ${mem.privateMb} MB private > ${maxPrivate} MB`);
    process.exitCode = 1;
  }
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
  const maxSettledPrivateMb = flag("max-settled-private-mb", Infinity);
  const maxPeakPrivateMb = flag("max-peak-private-mb", Infinity);
  // --cold: the first open after a cache clear (HP: 988 MB idle cold vs
  // ~330-410 MB warm). No scan cache, and the OS file cache dropped.
  if (rest.includes("--cold")) {
    rmSync(path.join(appCacheDir(), "scan"), { recursive: true, force: true });
    const flush = spawnSync(process.platform === "win32" ? "python" : "python3", [path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "flush-file-cache.py")], { encoding: "utf8" });
    console.error(`cold: ${(flush.stdout || flush.stderr || "file cache flush unavailable").trim()}`);
  }
  const started = performance.now();
  const child = spawn(binary, [study], {
    env: { ...process.env, ...benchEnv({ BENCH: "1", BENCH_VIEW: process.env.FLOWRAD_BENCH_VIEW ?? process.env.RADLEARN_BENCH_VIEW ?? "mpr" }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let peak = null;
  let report = null;
  let peakWs = null;
  const timeline = [];
  const sample = () => {
    try {
      const m = treeMemory(child.pid);
      if (!peak || m.privateMb > peak.privateMb) peak = m;
      if (!peakWs || m.wsMb > peakWs.wsMb) peakWs = m;
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
    view: process.env.FLOWRAD_BENCH_VIEW ?? "mpr",
    cold: rest.includes("--cold"),
    study,
    images: report.images,
    engineStarted: report.engineInitMs != null || report.engineStartMs != null,
    volumeLoadedMs: r0(report.volumeLoadedMs),
    volumeBuildMs: r0(report.volumeBuildMs),
    peakPrivateMb: peak?.privateMb,
    settledPrivateMb: settled?.privateMb,
    // Working set too: it is what Task Manager shows (and what the HP numbers
    // quote). Summed per process, so DLL pages shared by the WebView2
    // processes count once per process: fewer processes, smaller sum.
    peakWsMb: peakWs?.wsMb,
    settledWsMb: settled?.wsMb,
    processes: settled?.processes.length ?? peak?.processes.length,
    settledByProcess: settled?.processes.filter((p) => p.wsMb > 10),
    browserArgs: process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? null,
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
  // Gates are on the whole tree's WORKING SET (what Task Manager and the HP
  // numbers show); private bytes are reported alongside.
  if (summary.peakWsMb > maxMb) over.push(`peak working set ${summary.peakWsMb} MB > ${maxMb} MB`);
  if (summary.volumeLoadedMs > maxMs) over.push(`build ${summary.volumeLoadedMs} ms > ${maxMs} ms`);
  if (summary.settledWsMb > maxSettledMb) over.push(`settled working set ${summary.settledWsMb} MB > ${maxSettledMb} MB`);
  // Private bytes (the HP 0.8.2 gates: commit the app holds, not what is paged in).
  if (summary.settledPrivateMb > maxSettledPrivateMb) over.push(`settled private ${summary.settledPrivateMb} MB > ${maxSettledPrivateMb} MB`);
  if (summary.peakPrivateMb > maxPeakPrivateMb) over.push(`peak private ${summary.peakPrivateMb} MB > ${maxPeakPrivateMb} MB`);
  // Native mode draws without the JS engine; starting it costs ~350 ms of
  // main thread on open plus its WebGL context and decode worker.
  if (rest.includes("--require-no-engine") && summary.engineStarted) over.push("the JS engine started in native mode");
  if (over.length) {
    console.error(`MPR gate failed: ${over.join("; ")}`);
    process.exitCode = 1;
  }
}

// Phase 2 (P2.1): the study opened by the NATIVE renderer (FLOWRAD_NATIVE=1,
// native-spike view): first image (decode + upload + draw), 120 slices of
// scrolling one call each, and the whole tree's memory at the report.
//   --max-first-image-ms N  warm (median) native first image, from the open call
//   --max-scroll-p95-ms N   per-slice scroll call p95
//   --max-idle-mb N         whole-tree working set at the report (study open)
async function benchNative(binary, study) {
  const runs = flag("runs", 3);
  const reports = [];
  for (let i = 0; i < runs; i += 1) {
    // BENCH_EXIT 0: the app stays up after its report, so the whole tree is
    // sampled while the study is open (runApp kills it after).
    const report = await runApp(binary, [study], { FLOWRAD_NATIVE: "1", ...benchEnv({ BENCH_VIEW: "native-spike", BENCH_EXIT: "0" }) });
    if (!report.study) throw new Error(`no native study report: ${JSON.stringify(report).slice(0, 400)}`);
    reports.push(report);
    const st = report.study;
    console.error(
      `run ${i + 1}: ${report.native?.adapter} (${report.native?.backend}) · list ${r0(st.listMs)} ms · first image ${r0(st.firstImageMs)} ms (decode ${r0(st.firstDecodeMs)}, frame ${st.firstFrameMs?.toFixed(1)}; ${r0(st.firstImageSinceStartMs)} ms after process start) · scroll p50 ${report.scroll?.p50Ms} p95 ${report.scroll?.p95Ms} max ${report.scroll?.maxMs} ms (cached ${Math.round((report.scroll?.cachedShare ?? 0) * 100)}%) · store ${report.store?.usedMb?.toFixed?.(1)} / ${report.store?.budgetMb} MB · tree ${report.tree?.wsMb} MB ws (${report.tree?.processes} processes) · long tasks max ${r0(report.longTasks?.maxMs)} ms`
    );
  }
  const warm = reports.slice(1).length ? reports.slice(1) : reports;
  const summary = {
    mode: "native",
    study,
    images: reports[0].study.images,
    firstImageMs: r0(median(warm.map((r) => r.study.firstImageMs))),
    scrollP95Ms: Math.max(...reports.map((r) => r.scroll?.p95Ms ?? 0)),
    treeWsMb: Math.max(...reports.map((r) => r.tree?.wsMb ?? 0)),
    adapter: reports[0].native?.adapter,
  };
  console.log(JSON.stringify(summary, null, 2));
  const over = [];
  if (summary.firstImageMs > flag("max-first-image-ms", Infinity)) over.push(`first image ${summary.firstImageMs} ms`);
  if (summary.scrollP95Ms > flag("max-scroll-p95-ms", Infinity)) over.push(`scroll p95 ${summary.scrollP95Ms} ms`);
  if (summary.treeWsMb > flag("max-idle-mb", Infinity)) over.push(`whole tree ${summary.treeWsMb} MB`);
  if (over.length) {
    console.error(`native gate failed: ${over.join("; ")}`);
    process.exitCode = 1;
  }
}

// Close lifecycle, in PRIVATE bytes over the whole process tree (the HP's
// numbers for 0.8.1: empty app 362 MB; a CT open 473-497 MB settled; the
// study closed, 454 MB 30 s later — 90 MB never came back):
//   1. baseline   the empty app after --baseline-seconds (default 10);
//   2. open       the study open in 2D (BENCH_VIEW=close), --settle s (default 20) after its report;
//   3. closed     the app closes it (Home), sampled --after-close s (default 30) later.
// Gates: --max-baseline-private-mb, --max-open-private-mb, --max-close-delta-mb
// (closed − baseline). Working set is reported alongside.
async function benchClose(binary, study) {
  const baselineSeconds = flag("baseline-seconds", 10);
  const settle = flag("settle", 20);
  const afterClose = flag("after-close", 30);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const brief = (m) => m && { privateMb: m.privateMb, wsMb: m.wsMb, processes: m.processes.length, byProcess: m.processes.map((p) => ({ type: p.type ?? p.name, privateMb: p.privateMb, wsMb: p.wsMb })) };

  // 1. Baseline: the empty app, as a reader starts it.
  const empty = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  empty.stdout.on("data", () => undefined);
  empty.stderr.on("data", () => undefined);
  await sleep(baselineSeconds * 1000);
  const baseline = empty.exitCode == null ? treeMemory(empty.pid) : null;
  // macOS: what each process holds, by kind, to name what a close leaves.
  const cats = (m) => Object.fromEntries((m?.processes ?? []).filter((p) => p.type === "app" || p.type === "renderer").map((p) => [p.type, footprintCategories(p.pid)]));
  const baselineCats = cats(baseline);
  empty.kill("SIGKILL");
  await sleep(2000);
  if (!baseline?.processes.length) throw new Error("close: the empty app is not running for its baseline");

  // 2 + 3. The study opened, held, closed.
  const started = performance.now();
  const child = spawn(binary, [study], {
    env: { ...process.env, ...benchEnv({ BENCH: "1", BENCH_VIEW: "close", BENCH_CLOSE_AFTER_MS: String(settle * 1000) }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const reports = [];
  const shellClose = [];
  let partial = "";
  child.stdout.on("data", (d) => {
    out = (out + d).slice(-8000);
    const lines = (partial + d).split("\n");
    partial = lines.pop() ?? "";
    for (const l of lines) {
      if (REPORT.test(l)) reports.push(JSON.parse(l.replace(REPORT, "")));
      // The shell's own account of the close: what each cache held, and the
      // process's commit before / after clearing / after the allocator release.
      else if (l.startsWith("FLOWRAD_BENCH_CLOSE ")) shellClose.push(JSON.parse(l.slice("FLOWRAD_BENCH_CLOSE ".length)));
    }
  });
  child.stderr.on("data", (d) => (out = (out + d).slice(-8000)));
  const until = async (ok, ms, what) => {
    const deadline = performance.now() + ms;
    while (!ok()) {
      if (child.exitCode != null || performance.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error(`close: no ${what} (exit ${child.exitCode}); output:\n${out.slice(-2000)}`);
      }
      await sleep(100);
    }
  };
  await until(() => reports.some((r) => !r.closed), 180_000, "report with the study open");
  const openedAt = performance.now();
  // Sample just before the app closes it: the study open and settled.
  await sleep(Math.max(0, settle * 1000 - 1500));
  const open = treeMemory(child.pid);
  const openCats = cats(open);
  await until(() => reports.some((r) => r.closed), settle * 1000 + 30_000, "close report");
  await sleep(afterClose * 1000);
  const closed = treeMemory(child.pid);
  const closedCats = cats(closed);
  child.kill("SIGKILL");

  const report = reports.find((r) => !r.closed);
  const summary = {
    mode: "close",
    study,
    images: report.images,
    native: process.env.FLOWRAD_NATIVE ?? null,
    openReportMs: r0(openedAt - started),
    baselinePrivateMb: baseline.privateMb,
    openPrivateMb: open.privateMb,
    closedPrivateMb: closed.privateMb,
    closeDeltaPrivateMb: closed.privateMb - baseline.privateMb,
    baselineWsMb: baseline.wsMb,
    openWsMb: open.wsMb,
    closedWsMb: closed.wsMb,
    afterCloseSeconds: afterClose,
    shellClose,
    baseline: brief(baseline),
    open: brief(open),
    closed: brief(closed),
  };
  console.log(JSON.stringify(summary, null, 2));
  const line = (m) => m.processes.map((p) => `${p.type ?? p.name} ${p.privateMb}`).join(", ");
  console.error(
    `CLOSE: private baseline ${baseline.privateMb} MB (${line(baseline)}) · open ${open.privateMb} MB (${line(open)}) · closed +${afterClose} s ${closed.privateMb} MB (${line(closed)}) · delta ${summary.closeDeltaPrivateMb} MB · ws ${baseline.wsMb} / ${open.wsMb} / ${closed.wsMb} MB`
  );
  for (const c of shellClose) console.error(`CLOSE (app process): ${JSON.stringify(c)}`);
  if (process.platform === "darwin") {
    // By kind of memory (footprint, dirty MB): closed vs. the empty app, and
    // closed vs. open (what the close did not give back).
    for (const kind of ["app", "renderer"]) {
      console.error(`CLOSE (${kind}, by kind): closed − baseline: ${footprintDelta(baselineCats[kind], closedCats[kind])} · closed − open: ${footprintDelta(openCats[kind], closedCats[kind])}`);
    }
  }
  // macOS: Metal's own count (in the app's footprint on Apple silicon): after
  // init (empty app), with the study open, after the close.
  const metal = report?.native?.gpuAllocatedMb;
  if (metal != null || report?.native?.gpuAllocatedInitMb != null) {
    const after = shellClose.find((c) => c.held)?.held?.gpuAllocatedMb;
    console.error(`CLOSE (Metal): init ${report.native.gpuAllocatedInitMb} MB · open ${metal} MB · after close ${after} MB`);
  }
  const over = [];
  const maxBaseline = flag("max-baseline-private-mb", Infinity);
  const maxOpen = flag("max-open-private-mb", Infinity);
  const maxDelta = flag("max-close-delta-mb", Infinity);
  if (summary.baselinePrivateMb > maxBaseline) over.push(`empty app ${summary.baselinePrivateMb} MB private > ${maxBaseline} MB`);
  if (summary.openPrivateMb > maxOpen) over.push(`study open ${summary.openPrivateMb} MB private > ${maxOpen} MB`);
  if (summary.closeDeltaPrivateMb > maxDelta) over.push(`after close ${summary.closedPrivateMb} MB private = baseline + ${summary.closeDeltaPrivateMb} MB > + ${maxDelta} MB`);
  if (over.length) {
    console.error(`close gate failed: ${over.join("; ")}`);
    process.exitCode = 1;
  }
}

const modes = {
  close: () => benchClose(positional[0], positional[1]),
  native: () => benchNative(positional[0], positional[1]),
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
  console.error("usage: bench.mjs desktop|coldstart|idle|browser|mpr|close|interact|leak|multiwindow|native …  (see header)");
  process.exit(2);
}
await modes[mode]();
