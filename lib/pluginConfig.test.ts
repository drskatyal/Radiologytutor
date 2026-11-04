import { test } from "node:test";
import assert from "node:assert/strict";
import { viewerPluginConfig } from "./pluginConfig.ts";

const pin = "a".repeat(64);
const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

test("off by default, even when a list is configured", () => {
  assert.deepEqual(viewerPluginConfig(env({})), { sources: [], problems: [] });
  assert.deepEqual(viewerPluginConfig(env({ VIEWER_PLUGINS: JSON.stringify([{ id: "x1", url: "/p.js", sha256: pin }]) })).sources, []);
});

test("enabled: only pinned, same-origin or allowlisted https sources load", () => {
  const { sources, problems } = viewerPluginConfig(
    env({
      VIEWER_PLUGINS_ENABLED: "1",
      VIEWER_PLUGIN_HOSTS: "plugins.flowrad.ai",
      VIEWER_PLUGINS: JSON.stringify([
        { id: "local-one", url: "/plugins/one.js", sha256: pin },
        { id: "remote-two", url: "https://plugins.flowrad.ai/two.js", sha256: pin.toUpperCase() },
        { id: "evil", url: "https://evil.example/x.js", sha256: pin },
        { id: "nohash", url: "/x.js" },
        { id: "proto", url: "//evil.example/x.js", sha256: pin },
        { id: "local-one", url: "/again.js", sha256: pin },
        { id: "Bad Id", url: "/x.js", sha256: pin },
      ]),
    })
  );
  assert.deepEqual(sources.map((s) => s.id), ["local-one", "remote-two"]);
  assert.equal(sources[1]!.sha256, pin);
  assert.equal(problems.length, 5);
});

test("bad JSON is a problem, not a crash", () => {
  assert.deepEqual(viewerPluginConfig(env({ VIEWER_PLUGINS_ENABLED: "1", VIEWER_PLUGINS: "{" })).sources, []);
});
