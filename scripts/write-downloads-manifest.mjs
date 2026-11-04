#!/usr/bin/env node
// Write desktop/downloads.json for viewer.flowrad.ai (read by lib/cloud/downloads.ts).
//
//   node scripts/write-downloads-manifest.mjs <dir> <version> <publicBaseUrl>
//
// Picks the Windows NSIS installer (*x64-setup.exe) and the universal macOS
// .dmg from <dir>, and records each file's size and SHA-256.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const [dir, version, base] = process.argv.slice(2);
if (!dir || !version || !base) {
  console.error("usage: write-downloads-manifest.mjs <dir> <version> <publicBaseUrl>");
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`bad version: ${version}`);
  process.exit(2);
}
if (!base.startsWith("https://")) {
  console.error("the public base URL must be https");
  process.exit(2);
}

const files = readdirSync(dir);
const pick = (re) => files.find((f) => re.test(f));
const entry = (file) => {
  if (!file) return undefined;
  const full = path.join(dir, file);
  return {
    url: `${base.replace(/\/+$/, "")}/${encodeURIComponent(file)}`,
    fileName: file,
    bytes: statSync(full).size,
    sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
  };
};

const platforms = {};
const windows = entry(pick(/x64-setup\.exe$/i));
const macos = entry(pick(/universal\.dmg$/i));
if (windows) platforms.windows = windows;
if (macos) platforms.macos = macos;
if (!windows && !macos) {
  console.error("no installers found");
  process.exit(1);
}

process.stdout.write(JSON.stringify({ version, publishedAt: new Date().toISOString(), platforms }, null, 2) + "\n");
