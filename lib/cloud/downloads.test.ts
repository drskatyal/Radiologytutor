import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedInstallerHost, formatInstallerSize, isDesktopPlatform, parseDownloadsManifest } from "./downloads.ts";

const good = {
  version: "0.8.3",
  publishedAt: "2026-11-01T00:00:00Z",
  platforms: {
    windows: {
      url: "https://storage.googleapis.com/flowrad-viewer-downloads/desktop/0.8.3/FlowRad.Viewer_0.8.3_x64-setup.exe",
      fileName: "FlowRad.Viewer_0.8.3_x64-setup.exe",
      bytes: 41_000_000,
      sha256: "a".repeat(64),
    },
    macos: {
      url: "https://storage.googleapis.com/flowrad-viewer-downloads/desktop/0.8.3/FlowRad.Viewer_0.8.3_universal.dmg",
      fileName: "FlowRad.Viewer_0.8.3_universal.dmg",
    },
  },
};

test("parses a valid manifest", () => {
  const m = parseDownloadsManifest(good);
  assert.equal(m?.version, "0.8.3");
  assert.equal(m?.platforms.windows?.bytes, 41_000_000);
  assert.equal(m?.platforms.macos?.sha256, undefined);
});

test("rejects garbage and bad versions", () => {
  assert.equal(parseDownloadsManifest(null), null);
  assert.equal(parseDownloadsManifest({ version: "latest", platforms: {} }), null);
});

test("drops entries on http or foreign hosts", () => {
  const m = parseDownloadsManifest({
    version: "1.0.0",
    platforms: {
      windows: { url: "http://storage.googleapis.com/x.exe", fileName: "x.exe" },
      macos: { url: "https://evil.example/x.dmg", fileName: "x.dmg" },
    },
  });
  assert.deepEqual(m?.platforms, {});
  const allowed = parseDownloadsManifest(
    { version: "1.0.0", platforms: { macos: { url: "https://dl.flowrad.ai/x.dmg", fileName: "x.dmg" } } },
    ["dl.flowrad.ai"]
  );
  assert.ok(allowed?.platforms.macos);
});

test("helpers", () => {
  assert.equal(allowedInstallerHost("bucket.storage.googleapis.com"), true);
  assert.equal(allowedInstallerHost("storage.googleapis.com.evil.io"), false);
  assert.equal(isDesktopPlatform("macos"), true);
  assert.equal(isDesktopPlatform("linux"), false);
  assert.equal(formatInstallerSize(41_000_000), "41 MB");
  assert.equal(formatInstallerSize(undefined), null);
});

test("installers are offered only when live AND signed (coming soon otherwise)", async () => {
  const { offeredInstaller } = await import("./downloads.ts");
  const m = parseDownloadsManifest({
    version: "1.0.0",
    platforms: {
      windows: { url: "https://storage.googleapis.com/b/w.exe", fileName: "w.exe", signed: true },
      macos: { url: "https://storage.googleapis.com/b/m.dmg", fileName: "m.dmg" },
    },
  });
  const live = { DESKTOP_DOWNLOADS_LIVE: "1" } as unknown as NodeJS.ProcessEnv;
  assert.equal(offeredInstaller(m, "windows", {} as NodeJS.ProcessEnv), null, "not live: coming soon");
  assert.equal(offeredInstaller(m, "windows", live)?.fileName, "w.exe");
  assert.equal(offeredInstaller(m, "macos", live), null, "unsigned entry is never offered");
  assert.equal(offeredInstaller(null, "windows", live), null);
});
