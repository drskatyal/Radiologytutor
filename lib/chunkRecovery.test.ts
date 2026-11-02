import { test } from "node:test";
import assert from "node:assert/strict";
import { importWithRetry, isChunkLoadError, mayReloadForChunkError } from "./chunkRecovery";

const chunkError = () => Object.assign(new Error("Loading chunk 2785 failed.\n(missing: /_next/static/chunks/2785.js)"), { name: "ChunkLoadError" });

test("recognises webpack, Vite and browser wordings of a failed chunk", () => {
  assert.ok(isChunkLoadError(chunkError()));
  assert.ok(isChunkLoadError(new Error("Loading CSS chunk 12 failed.")));
  assert.ok(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/a.js")));
  assert.ok(isChunkLoadError(new TypeError("error loading dynamically imported module")));
  assert.ok(isChunkLoadError(new TypeError("Importing a module script failed.")));
  assert.ok(!isChunkLoadError(new Error("Viewport with Id x does not exist")));
  assert.ok(!isChunkLoadError(null));
});

test("retries a chunk failure twice with growing backoff, then succeeds", async () => {
  const waits: number[] = [];
  let calls = 0;
  const value = await importWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw chunkError();
      return "module";
    },
    { sleep: async (ms) => void waits.push(ms), baseDelayMs: 100 }
  );
  assert.equal(value, "module");
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 100 && waits[0] < 130 && waits[1] >= 200 && waits[1] < 230, String(waits));
});

test("gives up after the retries with the chunk error", async () => {
  let calls = 0;
  await assert.rejects(
    importWithRetry(async () => {
      calls += 1;
      throw chunkError();
    }, { sleep: async () => {} }),
    (error: Error) => error.name === "ChunkLoadError"
  );
  assert.equal(calls, 3);
});

test("does not retry a module that loaded and threw", async () => {
  let calls = 0;
  await assert.rejects(
    importWithRetry(async () => {
      calls += 1;
      throw new Error("boom");
    }, { sleep: async () => {} }),
    /boom/
  );
  assert.equal(calls, 1);
});

test("reload guard: once per window, never without storage", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const now = 1_000_000_000;
  assert.equal(mayReloadForChunkError(now, storage), true);
  storage.setItem("flowrad:chunk-reload", String(now));
  assert.equal(mayReloadForChunkError(now + 60_000, storage), false, "a second failure a minute later does not reload again");
  assert.equal(mayReloadForChunkError(now + 6 * 60_000, storage), true, "later it may");
  assert.equal(mayReloadForChunkError(now, null), false, "no storage: no guard, so no automatic reload");
});
