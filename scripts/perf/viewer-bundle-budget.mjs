#!/usr/bin/env node
// Bundle budget for the free viewer's shell (/viewer).
//
//   node scripts/perf/viewer-bundle-budget.mjs [--route /viewer] [--budget-kb 300] [--json out.json]
//
// Run after `npm run build`. Sums the gzipped size of every JS file the route
// needs before the user does anything — the webpack runtime, framework, root
// layout and page chunks (the app-router build manifest for the route plus the
// root layout) — and fails when it is over budget. The imaging engine
// (Cornerstone, its decode worker, WASM codecs) and the tools (MPR, 3D,
// measurements) are NOT counted: they are split out and load after a drop or
// on click. Their sizes are reported separately so a regression that pulls
// them into the shell shows up as a jump in the shell number.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const route = arg("--route", "/viewer");
const budgetKb = Number(arg("--budget-kb", "300"));
const jsonOut = arg("--json", null);

const NEXT = path.join(process.cwd(), ".next");
const manifest = JSON.parse(fs.readFileSync(path.join(NEXT, "app-build-manifest.json"), "utf8")).pages;
const pageKey = `${route === "/" ? "" : route}/page`;
const pageFiles = manifest[pageKey];
if (!pageFiles) {
  console.error(`No build-manifest entry for ${pageKey}. Run \`npm run build\` first.`);
  process.exit(2);
}
const shellFiles = [...new Set([...(manifest["/layout"] ?? []), ...pageFiles])].filter((f) => f.endsWith(".js"));

const gz = (file) => zlib.gzipSync(fs.readFileSync(path.join(NEXT, file)), { level: 9 }).length;
const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;

const shell = shellFiles.map((file) => ({ file, gzip: gz(file) })).sort((a, b) => b.gzip - a.gzip);
const shellGzip = shell.reduce((sum, f) => sum + f.gzip, 0);

// Lazy chunks of interest: anything not in the shell that is big, by name hint.
const chunkDir = path.join(NEXT, "static");
const lazy = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|wasm)$/.test(entry.name)) {
      const rel = path.relative(NEXT, full);
      if (!shellFiles.includes(rel)) lazy.push({ file: rel, gzip: gz(rel) });
    }
  }
};
walk(chunkDir);
const wasm = lazy.filter((f) => f.file.endsWith(".wasm")).sort((a, b) => b.gzip - a.gzip);
const bigLazyJs = lazy.filter((f) => f.file.endsWith(".js") && f.gzip > 100 * 1024).sort((a, b) => b.gzip - a.gzip);

const report = {
  route,
  budgetKb,
  shellGzipKb: kb(shellGzip),
  shellFiles: shell.map((f) => ({ file: f.file, gzipKb: kb(f.gzip) })),
  lazyWasm: wasm.map((f) => ({ file: f.file, gzipKb: kb(f.gzip) })),
  lazyLargeJs: bigLazyJs.slice(0, 12).map((f) => ({ file: f.file, gzipKb: kb(f.gzip) })),
  pass: shellGzip <= budgetKb * 1024,
};

console.log(`Shell JS for ${route}: ${report.shellGzipKb} KB gzipped (budget ${budgetKb} KB) — ${report.pass ? "PASS" : "FAIL"}`);
for (const f of report.shellFiles) console.log(`  ${String(f.gzipKb).padStart(7)} KB  ${f.file}`);
console.log(`Lazy (after drop / on click), not in the shell:`);
for (const f of report.lazyLargeJs) console.log(`  ${String(f.gzipKb).padStart(7)} KB  ${f.file}`);
for (const f of report.lazyWasm) console.log(`  ${String(f.gzipKb).padStart(7)} KB  ${f.file}  (WASM codec)`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
