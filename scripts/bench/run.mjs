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
const METADATA_BUILD_MS = Number(arg("metadata-build", 400));
const SCROLL_SLICES = Number(arg("scroll", 24));
const REPEATS = Number(arg("repeats", 2));
const ROWS = Number(arg("rows", 512));
const COLUMNS = Number(arg("columns", ROWS));

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
const PROFILES = [
  { label: "baseline", runtime: "baseline", countHint: false, directionalPrefetch: false },
  { label: "engine", runtime: "tuned", countHint: false, directionalPrefetch: false },
  { label: "prefetch", runtime: "baseline", countHint: false, directionalPrefetch: true },
  { label: "counthint", runtime: "baseline", countHint: true, directionalPrefetch: false },
  { label: "tuned", runtime: "tuned", countHint: true, directionalPrefetch: true },
];

async function main() {
  console.log(
    `bundling harness… (slices=${SLICES}, ${ROWS}x${COLUMNS}, latency=${LATENCY_MS}ms, ` +
      `metadata build=${METADATA_BUILD_MS}ms)`
  );
  await bundle();

  const server = await startMockDicomweb({
    slices: SLICES,
    rows: ROWS,
    columns: COLUMNS,
    latencyMs: LATENCY_MS,
    metadataBuildMs: METADATA_BUILD_MS,
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
        if (payload.error) {
          console.error(`${profile.label} failed:\n${payload.error}`);
          throw new Error(`${profile.label} harness error`);
        }
        runs.push({ repeat, ...payload, requests: { ...server.counters } });
        console.log(
          `  run ${repeat} ${profile.label.padEnd(8)} ` +
            `engine ${String(payload.moduleMs).padStart(5)}ms  ` +
            `open ${String(payload.openMs).padStart(5)}ms  ` +
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
      `${label.padEnd(9)} open ${r.openMs}ms · ready ${r.seriesReadyMs}ms · ` +
        `cold ${r.coldMsPerSlice}ms/slice · warm ${r.warmFps} slices/s · ` +
        `heap ${r.jsHeapMb}MB · cache ${r.cacheMb}MB · workers ${r.workers} · ` +
        `qido ${r.requests.qido} reqs / ${Math.round(r.requests.qidoBytes / 1024)}KB`
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
