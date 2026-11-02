import assert from "node:assert/strict";
import { test } from "node:test";
import { deadline, toVoiceError, voiceErrorText, voiceModelAvailable, VoiceError } from "../packages/viewer-core/src/voiceSession";

const domError = (name: string) => Object.assign(new Error(name), { name });

test("voice: every microphone failure maps to an actionable error, never a hang", () => {
  assert.equal(toVoiceError(domError("NotAllowedError")).kind, "denied");
  assert.equal(toVoiceError(domError("NotFoundError")).kind, "no-mic");
  assert.equal(toVoiceError(domError("OverconstrainedError")).kind, "no-mic");
  assert.equal(toVoiceError(domError("NotReadableError")).kind, "mic-busy");
  assert.equal(toVoiceError("Failed to sync file system").kind, "load");
  assert.equal(toVoiceError(5872808).kind, "load");
  const own = new VoiceError("timeout", voiceErrorText("timeout"));
  assert.equal(toVoiceError(own), own);
  for (const kind of ["denied", "no-mic", "mic-busy", "insecure", "missing", "load", "timeout", "permission-timeout"] as const) {
    assert.ok(voiceErrorText(kind).length > 10, kind);
  }
  assert.match(voiceErrorText("denied"), /Retry/);
});

test("voice: deadline rejects a promise that never settles", async () => {
  const never = new Promise<void>(() => undefined);
  const d = deadline(never, 30, () => new VoiceError("timeout", "t"));
  await assert.rejects(d.promise, (e: unknown) => e instanceof VoiceError && e.kind === "timeout");
});

test("voice: deadline restarts while progress keeps arriving (a slow download is not a stall)", async () => {
  let resolve!: () => void;
  const slow = new Promise<void>((r) => (resolve = r));
  const d = deadline(slow, 40, () => new VoiceError("timeout", "t"));
  const ticker = setInterval(d.keepAlive, 15);
  setTimeout(() => {
    clearInterval(ticker);
    resolve();
  }, 150);
  await d.promise;
});

test("voice: a missing model is detected (404, or an SPA fallback serving index.html)", async () => {
  const respond = (status: number, type: string) =>
    (async () => new Response(null, { status, headers: { "content-type": type } })) as unknown as typeof fetch;
  assert.equal(await voiceModelAvailable("/voice/model.tar.gz", respond(200, "application/gzip")), true);
  assert.equal(await voiceModelAvailable("/voice/model.tar.gz", respond(404, "text/html")), false);
  assert.equal(await voiceModelAvailable("/voice/model.tar.gz", respond(200, "text/html; charset=utf-8")), false);
  const offline = (async () => {
    throw new TypeError("network");
  }) as unknown as typeof fetch;
  assert.equal(await voiceModelAvailable("/voice/model.tar.gz", offline), false);
});
