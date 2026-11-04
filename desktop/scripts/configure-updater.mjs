#!/usr/bin/env node
// Apply desktop/updater.json (the updater public key and update endpoint) to
// the build. One committed file is the source of truth:
//
//   node desktop/scripts/configure-updater.mjs           write tauri.conf.json, print env for the Rust build
//   node desktop/scripts/configure-updater.mjs --check   fail if tauri.conf.json drifted (CI)
//   node desktop/scripts/configure-updater.mjs --github-env "$GITHUB_ENV"   also export FLOWRAD_UPDATE_BASE / _FALLBACK
//
// Environment overrides (staging builds only): FLOWRAD_UPDATE_BASE.
//
// Safety: this script refuses anything that looks like a PRIVATE key in the
// public-key slot, and it never reads or prints TAURI_SIGNING_PRIVATE_KEY. It
// only reports whether that secret is present (the release workflow decides
// whether the build produces signed update artefacts).

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = path.join(desktop, "updater.json");
const confPath = path.join(desktop, "src-tauri", "tauri.conf.json");

export function validateUpdaterConfig(cfg) {
  const problems = [];
  let pubText = "";
  try {
    pubText = Buffer.from(String(cfg.pubkey ?? ""), "base64").toString("utf8");
  } catch {
    /* reported below */
  }
  if (/secret key|private key/i.test(pubText) || /secret key|private key/i.test(String(cfg.pubkey ?? ""))) {
    problems.push("pubkey holds a PRIVATE key. Remove it from the repository now and rotate it (docs/UPDATES.md).");
  } else if (!/^untrusted comment: minisign public key/.test(pubText)) {
    problems.push("pubkey must be the base64 of a minisign public key file (tauri signer generate → .pub).");
  }
  let base;
  try {
    base = new URL(String(cfg.channelBase ?? ""));
  } catch {
    base = null;
  }
  if (!base || base.protocol !== "https:" || base.search || base.pathname !== "/") {
    problems.push("channelBase must be a bare https origin, e.g. https://viewer.flowrad.ai");
  }
  if (cfg.fallbackManifestUrl != null) {
    let f;
    try {
      f = new URL(String(cfg.fallbackManifestUrl));
    } catch {
      f = null;
    }
    if (!f || f.protocol !== "https:" || f.search || String(cfg.fallbackManifestUrl).includes("{{")) {
      problems.push("fallbackManifestUrl must be a fixed https URL with no query or template (privacy rule).");
    }
  }
  return problems;
}

export function updaterEndpoints(cfg) {
  const base = String(cfg.channelBase).replace(/\/+$/, "");
  return [`${base}/api/desktop/update`, ...(cfg.fallbackManifestUrl ? [String(cfg.fallbackManifestUrl)] : [])];
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const ghEnvIdx = args.indexOf("--github-env");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  if (process.env.FLOWRAD_UPDATE_BASE) cfg.channelBase = process.env.FLOWRAD_UPDATE_BASE;
  const problems = validateUpdaterConfig(cfg);
  if (problems.length) {
    for (const p of problems) console.error(`updater.json: ${p}`);
    process.exit(1);
  }
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  const want = { ...(conf.plugins?.updater ?? {}), pubkey: cfg.pubkey, endpoints: updaterEndpoints(cfg) };
  if (check) {
    if (JSON.stringify(conf.plugins?.updater) !== JSON.stringify(want)) {
      console.error("tauri.conf.json plugins.updater does not match desktop/updater.json. Run: node desktop/scripts/configure-updater.mjs");
      process.exit(1);
    }
    console.log("updater config: OK");
    return;
  }
  conf.plugins = { ...(conf.plugins ?? {}), updater: want };
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
  const base = String(cfg.channelBase).replace(/\/+$/, "");
  console.log(`updater: endpoints ${want.endpoints.join(", ")}`);
  console.log(`updater: signing secret ${process.env.TAURI_SIGNING_PRIVATE_KEY ? "present" : "ABSENT (no signed update artefacts)"}`);
  if (ghEnvIdx >= 0 && args[ghEnvIdx + 1]) {
    appendFileSync(args[ghEnvIdx + 1], `FLOWRAD_UPDATE_BASE=${base}\n` + (cfg.fallbackManifestUrl ? `FLOWRAD_UPDATE_FALLBACK=${cfg.fallbackManifestUrl}\n` : ""));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
