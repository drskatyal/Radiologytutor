import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// The recognizer worker both apps ship (scripts/build-voice-worker.mjs): every
// checked patch applies to the installed vosk-browser, and the result holds no
// dynamic code — under the desktop CSP (no 'unsafe-eval') `new Function` was
// what hung the mic in 0.6.4–0.8.0.

test("voice worker: patches apply and no new Function / eval is left", async () => {
  const { patchVoiceWorker, DYNAMIC_CODE, SAFE_NAMED_FUNCTION } = await import("../scripts/voiceWorkerPatch.mjs");
  const bundle = readFileSync(path.join(__dirname, "..", "node_modules", "vosk-browser", "dist", "vosk.js"), "utf8");
  const worker: string = patchVoiceWorker(bundle);
  assert.doesNotMatch(worker, DYNAMIC_CODE);
  assert.ok(!worker.includes("new Function"), "no new Function");
  assert.ok(!/[^.\w]eval\(/.test(worker), "no eval(");
  assert.ok(worker.includes(SAFE_NAMED_FUNCTION), "embind names wrappers without eval");
  assert.ok(worker.includes('event:"progress"'), "download progress is reported");
  assert.ok(!worker.includes("this.Vosk.FS.mount(this.Vosk.IDBFS"), "no IndexedDB persistence");
});

test("voice worker: a changed vosk-browser fails the build instead of shipping half-patched", async () => {
  const { patchVoiceWorker } = await import("../scripts/voiceWorkerPatch.mjs");
  const fake = `createBase64WorkerFactory('${Buffer.from("self.onmessage=function(){}").toString("base64")}'`;
  assert.throws(() => patchVoiceWorker(fake), /expected one/);
  assert.throws(() => patchVoiceWorker("nothing here"), /not found/);
});
