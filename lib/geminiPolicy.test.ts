import { test } from "node:test";
import assert from "node:assert/strict";
import { deprecatedGeminiSampling, stripDeprecatedSampling } from "./geminiPolicy.ts";

test("sampling deprecation covers 3.6+, future majors and documented 3.5 Flash Lite", () => {
  for (const model of ["gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.8-live", "gemini-3.8-flash-tts", "models/gemini-4-flash", "gemini-3.10-flash", "gemini-3.5-flash-lite"]) {
    assert.equal(deprecatedGeminiSampling(model), true, model);
    const config = { temperature: 0, top_p: 1, top_k: 10, topP: 1, topK: 10, responseMimeType: "application/json" };
    stripDeprecatedSampling(model, config);
    assert.deepEqual(config, { responseMimeType: "application/json" });
  }
});

test("older models retain their explicit sampling settings", () => {
  for (const model of ["gemini-2.5-flash", "gemini-3.1-pro", "gemini-3.5-flash"]) {
    const config = { temperature: 0.2, topP: 0.9 };
    stripDeprecatedSampling(model, config);
    assert.deepEqual(config, { temperature: 0.2, topP: 0.9 });
  }
});
