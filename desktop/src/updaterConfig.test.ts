import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs build script, no types
import { updaterEndpoints, validateUpdaterConfig } from "../scripts/configure-updater.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(path.join(root, "updater.json"), "utf8"));
const b64 = (s: string) => Buffer.from(s).toString("base64");

test("the committed updater config is valid and points at viewer.flowrad.ai", () => {
  assert.deepEqual(validateUpdaterConfig(cfg), []);
  assert.deepEqual(updaterEndpoints(cfg), ["https://viewer.flowrad.ai/api/desktop/update"]);
});

test("tauri.conf.json carries exactly the committed public key and endpoints", () => {
  const conf = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  assert.equal(conf.plugins.updater.pubkey, cfg.pubkey);
  assert.deepEqual(conf.plugins.updater.endpoints, updaterEndpoints(cfg));
});

test("a private key in the public slot is refused", () => {
  const problems = validateUpdaterConfig({ ...cfg, pubkey: b64("untrusted comment: rsign encrypted secret key\nRWRTY0Iy...") });
  assert.match(problems.join(" "), /PRIVATE key/);
});

test("endpoints must be fixed https URLs (no query, no template)", () => {
  assert.ok(validateUpdaterConfig({ ...cfg, channelBase: "http://viewer.flowrad.ai" }).length);
  assert.ok(validateUpdaterConfig({ ...cfg, channelBase: "https://viewer.flowrad.ai/x?y=1" }).length);
  assert.ok(validateUpdaterConfig({ ...cfg, fallbackManifestUrl: "https://x.example/{{target}}/latest.json" }).length);
});
