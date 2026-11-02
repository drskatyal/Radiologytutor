#!/usr/bin/env node
// Markdown perf table for the free viewer, from the CI gate outputs:
//
//   node scripts/perf/viewer-perf-table.mjs <bundle.json> <test-results/perf/free-viewer.json>
//
// bundle.json comes from scripts/perf/viewer-bundle-budget.mjs --json; the
// second file from e2e/visual/free-viewer.perf.spec.ts. Prints the table that
// goes into the job summary and on the PR. Numbers only — no identifiers.

import fs from "node:fs";

const [bundlePath, perfPath] = process.argv.slice(2);
const read = (p) => (p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
const bundle = read(bundlePath);
const perf = read(perfPath) ?? {};
const ct = perf.ct520;
const mr = perf.mrZip;
const cap = perf.memoryCap;

const ok = (pass) => (pass ? "✅" : "❌");
const v = (x, unit = "") => (x == null ? "—" : `${x}${unit}`);
const rows = [];
const row = (metric, value, budget, pass) => rows.push(`| ${metric} | ${value} | ${budget} | ${pass == null ? "" : ok(pass)} |`);

if (bundle) {
  row("Shell JS, gzipped (`/viewer`, before any drop)", `${bundle.shellGzipKb} KB`, `≤ ${bundle.budgetKb} KB`, bundle.pass);
  const engine = (bundle.lazyLargeJs ?? []).reduce((s, f) => s + f.gzipKb, 0);
  row("Engine + tools, lazy (loaded on idle / after drop)", `${Math.round(engine)} KB`, "not in shell", null);
  const wasm = (bundle.lazyWasm ?? []).map((f) => `${f.file.split("/").pop().split(".")[0]} ${f.gzipKb} KB`).join(", ");
  row("WASM codecs, lazy (only the transfer syntax in use)", wasm || "—", "not in shell", null);
}
if (ct) {
  row(`First image — ${ct.study}`, v(ct.firstImageMs, " ms"), "≤ 1000 ms", ct.firstImageMs <= 1000);
  row("All 520 headers parsed (worker pool) → stack scrollable", v(ct.seriesReadyMs, " ms"), "", null);
  const s = ct.scroll ?? {};
  row(`Scroll ${s.steps} slices: longest main-thread task`, v(s.longestTaskMs, " ms"), "≤ 50 ms", s.longestTaskMs <= 50);
  row(
    `Scroll frame time p50 / p95 / max (${s.softwareGpu ? "software GPU" : "GPU"})`,
    `${v(s.frameP50Ms)} / ${v(s.frameP95Ms)} / ${v(s.frameMaxMs)} ms`,
    `p95 ≤ ${s.frameP95BudgetMs} ms`,
    s.frameP95Ms <= s.frameP95BudgetMs
  );
  const m = ct.memory ?? {};
  row("Decoded cache, study open / cap", `${v(m.cacheMb, " MB")} / ${v(m.cacheCapMb, " MB")}`, "≤ cap", m.cacheMb <= m.cacheCapMb);
  row(
    "After **Close study**: decoded cache / file handles / cached Part 10 buffers",
    `${v(m.cacheAfterCloseMb, " MB")} / ${v(m.filesAfterClose)} / ${v(m.metadataEntriesAfterClose)}`,
    "0 / 0 / 0",
    m.cacheAfterCloseMb === 0 && m.filesAfterClose === 0 && m.metadataEntriesAfterClose === 0
  );
  row("JS heap open → closed", `${v(m.jsHeapOpenMb, " MB")} → ${v(m.jsHeapClosedMb, " MB")}`, "", null);
  row(
    "Renderer+GPU RSS: before open → open → after close (no forced GC)",
    `${v(m.rendererRssIdleMb)} → ${v(m.rendererRssOpenMb)} → ${v(m.rendererRssClosedMb)} MB (settled in ${v(m.closeSettleMs, " ms")})`,
    "after close ≤ before open + 64 MB",
    m.rendererRssIdleMb == null || m.rendererRssClosedMb <= m.rendererRssIdleMb + 64
  );
  if (ct.reopenFirstImageMs != null) row("First image when reopening after Close study", v(ct.reopenFirstImageMs, " ms"), "≤ 1000 ms", ct.reopenFirstImageMs <= 1000);
  row("WASM fetched for uncompressed CT", ct.wasmFetched?.length ? ct.wasmFetched.join(", ") : "none", "none", !ct.wasmFetched?.length);
  row("Privacy: requests after drop / violations", `${v(ct.requestsAfterDrop)} / ${ct.privacyViolations?.length ?? "—"}`, "static GETs only / 0", (ct.privacyViolations?.length ?? 1) === 0);
}
if (cap) {
  row(
    `Memory cap, emulated ${cap.emulatedDeviceMemoryGb} GB device, full 520-slice scroll: decoded peak / cap`,
    `${v(cap.cachePeakMb, " MB")} / ${v(cap.cacheCapMb, " MB")}`,
    "≤ cap (evicts)",
    cap.cachePeakMb <= cap.cacheCapMb
  );
  if (cap.residentPeakMb != null) {
    row(
      "…decoded + raw Part 10 files held, peak / device budget",
      `${v(cap.residentPeakMb, " MB")} / ${v(cap.deviceBudgetMb, " MB")}`,
      "≤ device budget",
      cap.residentPeakMb <= cap.deviceBudgetMb
    );
    row("…renderer+GPU RSS idle → peak while scrolling", `${v(cap.rendererRssIdleMb)} → ${v(cap.rendererRssPeakMb)} MB`, "", null);
  }
}
if (mr) {
  row(`First image — ${mr.study}`, v(mr.firstImageMs, " ms"), "≤ 1000 ms", mr.firstImageMs <= 1000);
  row("MR: all headers parsed → stack scrollable", v(mr.seriesReadyMs, " ms"), "", null);
  row("MR: series switch → painted", v(mr.seriesSwitchMs, " ms"), "", null);
  const names = [...new Set(mr.wasmFetched ?? [])].map((n) => n.split(".")[0]);
  row("WASM fetched for J2K MR", names.join(", ") || "none", "OpenJPEG only", names.length > 0 && names.every((n) => n.startsWith("openjpeg")));
  row("Privacy: requests after drop / violations", `${v(mr.requestsAfterDrop)} / ${mr.privacyViolations?.length ?? "—"}`, "static GETs only / 0", (mr.privacyViolations?.length ?? 1) === 0);
}

const gpu = ct?.scroll?.gpu;
console.log("### FlowRad Viewer (free, `/viewer`) — perf gates\n");
console.log("| Metric | Result | Budget | |");
console.log("| --- | --- | --- | --- |");
for (const r of rows) console.log(r);
if (gpu) console.log(`\n<sub>Chromium headless. WebGL renderer: ${gpu}.</sub>`);
