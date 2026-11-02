#!/usr/bin/env node
// Voice commands on a deployed free viewer (/viewer): does the mic reach
// "listening", how long it takes, and does a spoken command act?
//
//   node scripts/prod-voice-probe.mjs <base-url> <study-dir> <wav> [--max-ready-ms 2000]
//
// Chromium's fake microphone plays <wav> (desktop/scripts/make-voice-wav.py:
// "layout two", "lung window", "zoom in"). Records a timeline of the mic
// button's state, every /voice and recognizer request with its status and
// size, worker starts and console errors, and writes it as Markdown (stdout +
// $GITHUB_STEP_SUMMARY). Exits non-zero when the mic never became ready, took
// longer than --max-ready-ms, or "lung window" did not set the lung window.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [base, studyDir, wav] = process.argv.slice(2);
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
if (!base || !studyDir || !wav) {
  console.error("usage: prod-voice-probe.mjs <base-url> <study-dir> <wav> [--max-ready-ms 2000]");
  process.exit(2);
}
const root = base.replace(/\/$/, "");
const maxReadyMs = Number(arg("--max-ready-ms", 2000));
const lines = [];
const out = (s = "") => lines.push(s);

const head = await fetch(`${root}/voice/model.tar.gz`, { method: "HEAD" }).then(
  (r) => `${r.status} ${r.headers.get("content-type") ?? ""} ${r.headers.get("content-length") ?? "?"} bytes, cache-control: ${r.headers.get("cache-control") ?? ""}`,
  (e) => `fetch failed: ${e.message}`
);

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH || undefined,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${path.resolve(wav)}`,
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const requests = [];
const consoleLines = [];
const workers = [];
page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`.slice(0, 300)));
page.on("worker", (w) => workers.push(w.url().slice(0, 120)));
page.on("requestfinished", async (r) => {
  if (!/voice|vosk|\.wasm/.test(r.url())) return;
  const res = await r.response();
  let size = "?";
  try {
    size = String((await res?.body())?.length ?? "?");
  } catch {
    /* streamed */
  }
  requests.push(`${res?.status()} ${r.url().replace(root, "")} (${size} bytes)`);
});
page.on("requestfailed", (r) => {
  if (/voice|vosk|\.wasm/.test(r.url())) requests.push(`FAILED ${r.url().replace(root, "")}: ${r.failure()?.errorText}`);
});

await page.goto(`${root}/viewer`, { waitUntil: "load" });
await page.waitForTimeout(2000);
await page.locator("input[type=file][webkitdirectory]").setInputFiles(studyDir);
await page.waitForFunction(() => performance.getEntriesByType("mark").some((m) => m.name.startsWith("radlearn:first-rendered")), null, { timeout: 60_000 });
await page.waitForTimeout(1000);

const mic = page.getByRole("button", { name: /^Voice commands/ }).first();
const label = async () => (await mic.getAttribute("aria-label").catch(() => null)) ?? "(no button)";
const timeline = [];
const clickedAt = Date.now();
await mic.click();
let readyMs = null;
let last = "";
while (Date.now() - clickedAt < 60_000) {
  const now = await label();
  const status = await page.locator('[data-testid="voice-status"]').innerText().catch(() => "");
  const line = `${now}${status ? ` | ${status.replace(/\s+/g, " ")}` : ""}`;
  if (line !== last) {
    timeline.push(`+${Date.now() - clickedAt} ms: ${line}`);
    last = line;
  }
  if (/^Voice commands on/.test(now)) {
    readyMs = Date.now() - clickedAt;
    break;
  }
  if (/error|blocked|not included|no microphone|failed/i.test(line)) break;
  await page.waitForTimeout(100);
}
let lung = false;
if (readyMs != null) {
  const until = Date.now() + 45_000;
  while (Date.now() < until && !lung) {
    lung = /W 1500\s+L [-−]600/.test(await page.locator("body").innerText());
    if (!lung) await page.waitForTimeout(500);
  }
}
await page.screenshot({ path: "prod-voice.png" });
await browser.close();

out(`### Voice commands on ${root}/viewer`);
out("");
out(`HEAD /voice/model.tar.gz: ${head}`);
out("");
out(`**Ready:** ${readyMs != null ? `${readyMs} ms after the click` : "NEVER (60 s)"} (budget ${maxReadyMs} ms)`);
out(`**"lung window" applied W 1500 / L −600:** ${lung ? "yes" : "no"}`);
out("");
out("Mic state timeline:");
for (const t of timeline) out(`- ${t}`);
out("");
out(`Voice / recognizer requests (${requests.length}):`);
for (const r of requests) out(`- \`${r}\``);
out("");
out(`Workers: ${workers.map((w) => `\`${w}\``).join(", ") || "none"}`);
out("");
out("Console (last 25):");
for (const c of consoleLines.slice(-25)) out(`- \`${c.replace(/`/g, "'")}\``);
const report = lines.join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
process.exit(readyMs != null && readyMs <= maxReadyMs && lung ? 0 : 1);
