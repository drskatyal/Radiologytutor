import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceStackStatus, geminiLiveModelId } from "./voice.ts";
import { getRealtimeVoiceInfo } from "./voiceRealtime.ts";

test("voiceStackStatus reports providers without throwing when keys absent", () => {
  const s = voiceStackStatus();
  assert.equal(typeof s.elevenLabs, "boolean");
  assert.equal(typeof s.geminiTts, "boolean");
  assert.ok(["elevenlabs", "gemini_tts", "none"].includes(s.primary));
});

test("geminiLiveModelId is a non-empty Live model string", () => {
  const id = geminiLiveModelId();
  assert.match(id, /gemini/i);
  assert.match(id, /live|flash/i);
});

test("getRealtimeVoiceInfo exposes the proxy path", () => {
  const info = getRealtimeVoiceInfo();
  assert.equal(info.proxyPath, "/api/voice/realtime");
  assert.ok(info.preferAfterMs >= 500);
});
