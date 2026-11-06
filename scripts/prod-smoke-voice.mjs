#!/usr/bin/env node
// Voice commands on the LIVE free viewer (/viewer), Chromium's fake microphone
// playing spoken test phrases (desktop/scripts/make-voice-wav.py; synthetic).
//
//   node scripts/prod-smoke-voice.mjs <base-url> <study-dir> <phrases.wav>
//
// Checks the deployment serves the model and the recognizer worker, the mic
// reaches "listening" (with a progress card while it loads — never an endless
// spinner), and a spoken "lung window" sets the lung window. Exit 1 otherwise.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [base, studyDir, wav] = process.argv.slice(2);
if (!base || !studyDir || !wav) {
  console.error("usage: prod-smoke-voice.mjs <base-url> <study-dir> <phrases.wav>");
  process.exit(2);
}
const root = base.replace(/\/$/, "");
const lines = [];
const fail = [];

for (const asset of ["/voice/model.tar.gz", "/voice/recognizer-worker.js"]) {
  const r = await fetch(root + asset, { method: "HEAD" });
  lines.push(`- \`${asset}\`: ${r.status} ${r.headers.get("content-type") ?? ""} ${r.headers.get("content-length") ?? ""}`);
  if (!r.ok || /text\/html/.test(r.headers.get("content-type") ?? "")) fail.push(`${asset} not served (${r.status})`);
}

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH || undefined,
  args: [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${path.resolve(wav)}`,
  ],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ["microphone"] });
const page = await context.newPage();
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`.slice(0, 300)));
await page.goto(`${root}/viewer`, { waitUntil: "load" });
const files = fs.readdirSync(studyDir).map((f) => path.join(studyDir, f));
await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(files);
await page.waitForFunction(() => performance.getEntriesByType("mark").some((m) => m.name.startsWith("radlearn:first-rendered")), null, { timeout: 90_000 });

const clicked = Date.now();
await page.getByRole("button", { name: /^Voice commands/ }).first().click();
let readyMs = null;
try {
  await page.getByRole("button", { name: /^Voice commands on/ }).first().waitFor({ timeout: 120_000 });
  readyMs = Date.now() - clicked;
} catch {
  const card = await page.getByTestId("voice-status").innerText().catch(() => "(no status card)");
  fail.push(`the mic never reached listening: ${card.replace(/\s+/g, " ")}`);
}
let heard = false;
if (readyMs != null) {
  const until = Date.now() + 60_000;
  while (Date.now() < until && !heard) {
    heard = /W 1500\s+L [-−]600/.test(await page.locator("body").innerText());
    if (!heard) await page.waitForTimeout(500);
  }
  if (!heard) fail.push("“lung window” was not applied within 60 s");
}
await page.screenshot({ path: "prod-smoke-voice.png" });
await browser.close();

lines.unshift(`### Voice commands on ${root}/viewer`, "");
lines.push("", `Ready after the click: ${readyMs == null ? "NEVER" : `${readyMs} ms`} · spoken “lung window” applied: ${heard ? "yes" : "no"}`);
if (fail.length) lines.push("", ...fail.map((f) => `- FAIL: ${f}`), "", "Console (last 20):", ...consoleLines.slice(-20).map((l) => `- \`${l.replace(/`/g, "'")}\``));
const report = lines.join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
process.exit(fail.length ? 1 : 0);
