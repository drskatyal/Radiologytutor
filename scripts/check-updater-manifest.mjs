#!/usr/bin/env node
// Check a Tauri updater manifest (latest.json) before it can be rolled out.
//   node scripts/check-updater-manifest.mjs <latest.json> [expected-version]
// Exits non-zero if Windows or macOS is missing, a URL isn't HTTPS, a
// signature is missing, or the version doesn't match. Prints a Markdown summary.
import { readFileSync } from "node:fs";

const [file, expected] = process.argv.slice(2);
if (!file) {
  console.error("usage: check-updater-manifest.mjs <latest.json> [expected-version]");
  process.exit(2);
}
const m = JSON.parse(readFileSync(file, "utf8"));
const problems = [];
if (!/^\d+\.\d+\.\d+/.test(String(m.version ?? ""))) problems.push(`version "${m.version}" is not semver`);
if (expected && String(m.version).replace(/^v/, "") !== expected) problems.push(`version ${m.version} != expected ${expected}`);
const platforms = m.platforms ?? {};
const keys = Object.keys(platforms);
if (!keys.some((k) => k.startsWith("windows-"))) problems.push("no Windows entry");
if (!keys.some((k) => k.startsWith("darwin-"))) problems.push("no macOS entry");
for (const [k, e] of Object.entries(platforms)) {
  if (!e || typeof e.url !== "string" || !e.url.startsWith("https://")) problems.push(`${k}: URL is not HTTPS`);
  if (!e || typeof e.signature !== "string" || e.signature.length < 40) problems.push(`${k}: missing signature`);
}
console.log(`### Update manifest ${m.version}\n`);
console.log("| Platform | Bundle |\n| --- | --- |");
for (const [k, e] of Object.entries(platforms)) console.log(`| ${k} | ${String(e?.url ?? "").split("/").pop()} |`);
console.log(problems.length ? `\n**Not ready:** ${problems.join("; ")}` : "\nReady to roll out after the HP test (docs/UPDATES.md).");
process.exit(problems.length ? 1 : 0);
