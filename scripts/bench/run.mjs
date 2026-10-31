// Viewer benchmark runner.  `node scripts/bench/run.mjs [--slices 240] [--latency 35]`
//
// Starts the synthetic WADO-RS origin (scripts/bench/mockDicomweb.mjs), bundles
// scripts/bench/harness.ts with esbuild, then opens the harness once per
// profile in a fresh headless Chrome and prints a table.
//
// It measures the shipped loader (`lib/progressiveStack.ts`) and the shipped
// engine knobs (`lib/viewerRuntime.ts`, `lib/prefetchPlan.ts`) against a
// fixed-latency origin. It is NOT a claim about a real archive: there is no
// Orthanc, no TLS, no R2, no WAN, and Chrome renders through SwiftShader here,
// so absolute render numbers are pessimistic. Network/decode/plan deltas
// between two profiles on the same machine are the signal.
//
// Profiles:
//   baseline  the literals that shipped in 71c006a (4 decode workers, default
//             3 GB image cache, QIDO-paged midpoint, pause-only prefetch)
//   tuned     lib/viewerRuntime + instanceCount hint + directional prefetch
//
// Results land in scripts/bench/results/<iso>.json (gitignored) and are
// summarised in docs/VIEWER_BENCHMARK.md.

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockDicomweb, SERIES_UID, STUDY_UID } from "./mockDicomweb.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const BUILD = join(HERE, ".build");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const SLICES = Number(arg("slices", 240));
const LATENCY_MS = Number(arg("latency", 35));
// Shared downstream link in Mbit/s; 0 = unlimited (localhost).
const BANDWIDTH_MBPS = Number(arg("bandwidth", 0));
const METADATA_BUILD_MS = Number(arg("metadata-build", 400));
const SCROLL_SLICES = Number(arg("scroll", 24));
const REPEATS = Number(arg("repeats", 2));
const ROWS = Number(arg("rows", 512));
const COLUMNS = Number(arg("columns", ROWS));
// Comma list to run a subset, e.g. `--profiles tuned,bundle`.
const ONLY = arg("profiles", "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

async function bundle() {
  await rm(BUILD, { recursive: true, force: true });
  await mkdir(BUILD, { recursive: true });
  const esbuild = await import(join(REPO, "node_modules", "esbuild", "lib", "main.js"));
  // The emscripten codec glue (`charlswasm_decode.js` and friends) carries a
  // Node branch that `require`s fs/path/crypto. next.config.mjs handles this
  // with `resolve.fallback = { fs: false }`; esbuild needs an empty stub.
  const nodeStub = {
    name: "node-builtin-stub",
    setup(build) {
      build.onResolve({ filter: /^(fs|path|crypto|os|url|worker_threads)$/ }, (args) => ({
        path: args.path,
        namespace: "node-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
        contents: "module.exports = {};",
        loader: "js",
      }));
    },
  };
  const shared = {
    plugins: [nodeStub],
    bundle: true,
    format: "esm",
    target: "chrome120",
    platform: "browser",
    outdir: BUILD,
    // The dicom-image-loader worker + wasm codecs are referenced as
    // `new URL(..., import.meta.url)`. Serving the bundle and its assets from
    // the same /bench/assets/ path makes those runtime URLs resolve.
    publicPath: "/bench/assets",
    loader: { ".wasm": "file" },
    assetNames: "[name]",
    logLevel: "warning",
    sourcemap: false,
    define: { "process.env.NODE_ENV": '"production"' },
  };
  await esbuild.build({
    ...shared,
    entryPoints: [join(HERE, "harness.ts")],
    entryNames: "harness",
  });
  // Same entry name the loader's `new URL('./decodeImageFrameWorker.js', …)` expects.
  await esbuild.build({
    ...shared,
    entryPoints: [
      join(
        REPO,
        "node_modules",
        "@cornerstonejs",
        "dicom-image-loader",
        "dist",
        "esm",
        "decodeImageFrameWorker.js"
      ),
    ],
    entryNames: "decodeImageFrameWorker",
  });
}

function runChrome(url) {
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      ...(process.env.BENCH_VERBOSE ? ["--enable-logging=stderr", "--v=0"] : []),
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--enable-precise-memory-info",
      "--js-flags=--expose-gc",
      "--window-size=1200,900",
      "--hide-scrollbars",
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const logs = [];
  chrome.stdout.on("data", (d) => logs.push(String(d)));
  chrome.stderr.on("data", (d) => logs.push(String(d)));
  return { chrome, logs };
}

// Each profile flips ONE thing relative to `baseline`, and `tuned` flips all
// of them, so the table attributes the delta instead of just reporting it.
const BASE = { runtime: "baseline", countHint: false, directionalPrefetch: false, prewarm: false };
const PROFILES = [
  { ...BASE, label: "baseline" },
  { ...BASE, label: "engine", runtime: "tuned" },
  { ...BASE, label: "prefetch", directionalPrefetch: true },
  { ...BASE, label: "counthint", countHint: true },
  { ...BASE, label: "prewarm", prewarm: true },
  {
    label: "tuned",
    runtime: "tuned",
    countHint: true,
    directionalPrefetch: true,
    prewarm: true,
  },
  // lib/dicomCdn: converted bundle (8-bit preview chunk → HTJ2K full chunk),
  // built by the real packer, served at the same per-request latency.
  {
    label: "bundle",
    runtime: "tuned",
    countHint: true,
    directionalPrefetch: true,
    prewarm: true,
    bundle: true,
  },
].filter((p) => ONLY.length === 0 || ONLY.includes(p.label));

async function packBundle() {
  const out = join(BUILD, "bundle");
  const tsx = join(REPO, "node_modules", ".bin", "tsx");
  const child = spawn(
    tsx,
    [join(HERE, "packBundle.ts"), "--slices", String(SLICES), "--rows", String(ROWS), "--columns", String(COLUMNS), "--out", out],
    { cwd: REPO, stdio: ["ignore", "pipe", "inherit"] }
  );
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) throw new Error(`packBundle exited ${code}`);
  console.log(`packed bundle: ${stdout.trim()}`);
  return out;
}

async function main() {
  console.log(
    `bundling harness… (slices=${SLICES}, ${ROWS}x${COLUMNS}, latency=${LATENCY_MS}ms, ` +
      `metadata build=${METADATA_BUILD_MS}ms, link=${BANDWIDTH_MBPS || "∞"} Mbit/s)`
  );
  await bundle();
  const bundleDir = PROFILES.some((p) => p.bundle) ? await packBundle() : null;

  const server = await startMockDicomweb({
    bundleDir,
    slices: SLICES,
    rows: ROWS,
    columns: COLUMNS,
    latencyMs: LATENCY_MS,
    metadataBuildMs: METADATA_BUILD_MS,
    bandwidthMbps: BANDWIDTH_MBPS,
  });
  console.log(`mock DICOMweb on ${server.origin}`);

  const runs = [];
  try {
    for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
      for (const profile of PROFILES) {
        const knobs = {
          ...profile,
          slices: SLICES,
          scrollSlices: SCROLL_SLICES,
          studyUID: STUDY_UID,
          seriesUID: SERIES_UID,
        };
        server.resetCounters();
        const url = `${server.origin}/bench/harness.html?knobs=${encodeURIComponent(
          JSON.stringify(knobs)
        )}`;
        const waiting = server.waitForResult();
        const { chrome, logs } = runChrome(url);
        let payload;
        try {
          payload = await waiting;
        } catch (error) {
          chrome.kill("SIGKILL");
          console.error(logs.join(""));
          throw error;
        }
        chrome.kill("SIGKILL");
        if (process.env.BENCH_VERBOSE) console.log(logs.join(""));
        if (payload.error) {
          console.error(`${profile.label} failed:\n${payload.error}`);
          throw new Error(`${profile.label} harness error`);
        }
        runs.push({ repeat, ...payload, requests: { ...server.counters } });
        console.log(
          `  run ${repeat} ${profile.label.padEnd(8)} ` +
            `engine ${String(payload.moduleMs).padStart(5)}ms  ` +
            `open ${String(payload.openMs).padStart(5)}ms${payload.openedOnPreview ? "*" : " "} ` +
            `full ${String(payload.fullQualityMs).padStart(5)}ms  ` +
            `ready ${String(payload.seriesReadyMs).padStart(5)}ms  ` +
            `cold ${String(payload.coldMsPerSlice).padStart(5)}ms/slice  ` +
            `warm ${String(payload.warmFps).padStart(5)} fps  ` +
            `heap ${payload.jsHeapMb}MB`
        );
      }
    }
  } finally {
    await server.close();
  }

  // Report the best run per profile — the benchmark machine is shared, and a
  // scheduler stall inflates a single run without telling us anything.
  const best = {};
  for (const run of runs) {
    const current = best[run.label];
    if (!current || run.openMs < current.openMs) best[run.label] = run;
  }

  console.log("\n=== best of each profile ===");
  for (const label of Object.keys(best)) {
    const r = best[label];
    console.log(
      `${label.padEnd(9)} open ${r.openMs}ms${r.openedOnPreview ? " (preview)" : ""} · ` +
        `full quality ${r.fullQualityMs}ms · ready ${r.seriesReadyMs}ms · ` +
        `cold ${r.coldMsPerSlice}ms/slice · warm ${r.warmFps} slices/s · ` +
        `heap ${r.jsHeapMb}MB · cache ${r.cacheMb}MB · workers ${r.workers} · ` +
        `qido ${r.requests.qido} reqs / ${Math.round(r.requests.qidoBytes / 1024)}KB · ` +
        `frames ${r.requests.frames} reqs · bundle ${r.requests.bundleChunks} reqs · ` +
        `${(r.requests.bytes / 1e6).toFixed(1)}MB`
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(HERE, "results", `${stamp}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    `${JSON.stringify(
      {
        machine: { cores: (await import("node:os")).cpus().length, node: process.version },
        config: {
          slices: SLICES,
          rows: ROWS,
          columns: COLUMNS,
          latencyMs: LATENCY_MS,
          metadataBuildMs: METADATA_BUILD_MS,
          bandwidthMbps: BANDWIDTH_MBPS,
          scrollSlices: SCROLL_SLICES,
        },
        runs,
      },
      null,
      2
    )}\n`
  );
  console.log(`\nwrote ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
