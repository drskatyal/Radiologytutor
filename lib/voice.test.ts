import { test } from "node:test";
import assert from "node:assert/strict";
import {
  voiceStackStatus,
  geminiLiveModelId,
  VOICE_LATENCY_BUDGET_MS,
  voiceRouteFor,
} from "./voice.ts";
import { getRealtimeVoiceInfo } from "./voiceRealtime.ts";

test("voiceStackStatus reports providers without throwing when keys absent", () => {
  const s = voiceStackStatus();
  assert.equal(typeof s.elevenLabs, "boolean");
  assert.equal(typeof s.geminiTts, "boolean");
  assert.equal(typeof s.realtimeAvailable, "boolean");
  assert.ok(["elevenlabs", "gemini_tts", "none"].includes(s.primary));
  assert.ok(s.latencyBudgetMs >= 500);
});

test("geminiLiveModelId is a non-empty Live model string", () => {
  const id = geminiLiveModelId();
  assert.match(id, /gemini/i);
  assert.match(id, /live|flash|native|audio/i);
});

test("VOICE_LATENCY_BUDGET_MS is a positive soft budget", () => {
  assert.ok(VOICE_LATENCY_BUDGET_MS >= 500);
  assert.ok(VOICE_LATENCY_BUDGET_MS <= 10_000);
});

test("teach-guide beats use Gemini even when a clone is enrolled", () => {
  assert.equal(
    voiceRouteFor({
      persona: "attending",
      voiceId: "clone",
      elevenLabs: true,
      gemini: true,
    }),
    "gemini_tts"
  );
  assert.equal(
    voiceRouteFor({
      voiceId: "clone",
      elevenLabs: true,
      gemini: true,
    }),
    "elevenlabs"
  );
  assert.equal(
    voiceRouteFor({ persona: "attending", elevenLabs: true, gemini: false }),
    "none"
  );
});

test("getRealtimeVoiceInfo exposes mint path + ws URL", () => {
  const info = getRealtimeVoiceInfo();
  assert.equal(info.proxyPath, "/api/voice/realtime");
  assert.ok(info.preferAfterMs >= 500);
  assert.match(info.wsUrl, /^wss:\/\//);
  assert.equal(info.apiVersion, "v1alpha");
  assert.ok(info.model.length > 0);
});
