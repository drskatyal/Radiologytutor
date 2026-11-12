import { test } from "node:test";
import assert from "node:assert/strict";
import { LATEST, ROLLBACK, REMOTE_CONFIG, channelResponse, isEnvelope, isManifest } from "./desktopChannel";

const sig = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK";
const manifest = {
  version: "0.8.3",
  notes: "Fixes.",
  pub_date: "2026-11-10T00:00:00Z",
  platforms: {
    "windows-x86_64": { signature: sig, url: "https://github.com/drskatyal/Radiologytutor/releases/download/desktop-v0.8.3/x.msi" },
    "darwin-aarch64": { signature: sig, url: "https://github.com/drskatyal/Radiologytutor/releases/download/desktop-v0.8.3/x.app.tar.gz" },
  },
};

test("channel: nothing is rolled out by default (every route answers 204)", async () => {
  assert.equal(LATEST, null);
  assert.equal(ROLLBACK, null);
  assert.equal(REMOTE_CONFIG, null);
  assert.equal(channelResponse(LATEST, isManifest).status, 204);
  assert.equal(channelResponse(REMOTE_CONFIG, isEnvelope).status, 204);
});

test("channel: a well-formed manifest is served as JSON", async () => {
  assert.equal(isManifest(manifest), true);
  const res = channelResponse(manifest, isManifest);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), manifest);
});

test("channel: a bad paste is not served (no http, no signature, odd platform)", () => {
  const http = { ...manifest, platforms: { "windows-x86_64": { signature: sig, url: "http://x/y.msi" } } };
  const unsigned = { ...manifest, platforms: { "windows-x86_64": { signature: "", url: manifest.platforms["windows-x86_64"].url } } };
  const odd = { ...manifest, platforms: { "beos-x86_64": manifest.platforms["windows-x86_64"] } };
  for (const bad of [http, unsigned, odd, { ...manifest, version: "latest" }, { ...manifest, platforms: {} }]) {
    assert.equal(isManifest(bad), false);
    assert.equal(channelResponse(bad, isManifest).status, 204);
  }
});

test("channel: config envelope must carry JSON text and a signature", () => {
  assert.equal(isEnvelope({ payload: '{"version":1}', signature: sig }), true);
  assert.equal(isEnvelope({ payload: "not json", signature: sig }), false);
  assert.equal(isEnvelope({ payload: '{"version":1}', signature: "" }), false);
});
