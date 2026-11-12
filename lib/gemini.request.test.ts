import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildGenerateRequest, buildTtsRequest, generate, runTeachingPlan, synthesizeSpeech, GeminiApiError, GeminiCapabilityError, GeminiConfigurationError, type GenerateOptions } from "./gemini";
import { compileStructuredSession } from "./compileSession";
import { buildLiveSetup, liveMintConstraints } from "./geminiLiveProtocol";
import { assertGeminiCapability } from "./geminiPolicy";
import { PhiError } from "./phiGuard";
import { TtsAudioError } from "./tts.wav";
import { synthesizeTutorSpeech } from "./voice";
import { extractionInput, planInput, ttsText } from "./fixtures/gemini/inputs";

const wav = Buffer.from("524946462800000057415645666d74201000000001000100c05d000080bb00000200100064617461040000000000ff7f", "hex");
const textReply = { modelVersion: "gemini-3.8-flash-001", candidates: [{ content: { parts: [{ text: '{"transcript":"Synthetic teaching observation.","findings":[]}' }] } }] };
const audioReply = { steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: wav.toString("base64") }] }] };
type Request = { url: string; body: Record<string, any>; headers: Headers };

async function mocked<T>(reply: unknown, run: (requests: Request[], logs: string[]) => Promise<T>, status = 200): Promise<T> {
  const envKeys = ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_TTS_MODEL", "GEMINI_TTS_VOICE", "GEMINI_MEDIA_RESOLUTION_FORM", "GEMINI_LIVE_MODEL", "ELEVENLABS_API_KEY", "ELEVENLABS_TTS_MODEL"];
  const saved = envKeys.map(key => process.env[key]);
  const previousFetch = globalThis.fetch;
  const previousInfo = console.info;
  const requests: Request[] = [];
  const logs: string[] = [];
  for (const key of envKeys) delete process.env[key];
  process.env.GEMINI_API_KEY = "synthetic-test-key";
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(reply), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  console.info = (...args: unknown[]) => { logs.push(args.join(" ")); };
  try { return await run(requests, logs); }
  finally {
    globalThis.fetch = previousFetch;
    console.info = previousInfo;
    envKeys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
}

function snapshot(name: string, request: Request) {
  const expected = JSON.parse(readFileSync(`lib/fixtures/gemini/${name}.json`, "utf8"));
  assert.deepEqual({ url: request.url, body: request.body }, expected);
  assert.equal(request.headers.get("x-goog-api-key"), "synthetic-test-key");
  assert.equal(request.url.includes("key"), false);
  assert.doesNotMatch(JSON.stringify(request.body), /"(?:temperature|top_p|top_k|topP|topK)"/);
}

describe("M3 Gemini REST requests (mocked; NOT VERIFIED LIVE)", { concurrency: 1 }, () => {
  test("extraction snapshot selects Flash, object resolution, and propagates observed provenance", async () => {
    await mocked(textReply, async (requests, logs) => {
      const result = await compileStructuredSession(extractionInput);
      assert.equal(requests.length, 1);
      snapshot("extraction", requests[0]);
      assert.deepEqual(requests[0].body.contents[0].parts[0].mediaResolution, { level: "MEDIA_RESOLUTION_LOW" });
      assert.equal(result.modelMetadata?.requestedModel, "gemini-3.8-flash");
      assert.equal(result.modelMetadata?.responseModelVersion, "gemini-3.8-flash-001");
      assert.equal(result.modelMetadata?.apiSurface, "generateContent");
      assert.match(result.modelMetadata!.configHash, /^[a-f0-9]{64}$/);
      assert.deepEqual(JSON.parse(logs[0].slice("[gemini.request] ".length)), result.modelMetadata);
      assert.doesNotMatch(logs.join(""), /synthetic-test-key|Synthetic teaching observation|AAAA/);
    });
  });

  test("plan snapshot selects Flash and returns all actions plus request provenance", async () => {
    await mocked({ ...textReply, candidates: [{ content: { parts: [{ text: "Review the series." }, { functionCall: { name: "show_finding", args: { findingId: "synthetic-finding" } } }] } }] }, async (requests) => {
      const plan = await runTeachingPlan(planInput);
      snapshot("plan", requests[0]);
      assert.equal(plan.modelMetadata?.requestedModel, "gemini-3.8-flash");
      assert.equal(plan.modelMetadata?.responseModelVersion, "gemini-3.8-flash-001");
      assert.equal(plan.actions.length, 1);
      assert.deepEqual(plan.action, plan.actions[0]);
    });
  });

  test("TTS snapshot uses Interactions speech_metadata and preserves unary WAV", async () => {
    await mocked(audioReply, async (requests) => {
      const result = await synthesizeSpeech(ttsText, { persona: "attending" });
      snapshot("tts", requests[0]);
      assert.equal(requests[0].body.input[0].content[0].text, ttsText);
      assert.equal(result.modelMetadata.requestedModel, "gemini-3.8-flash-tts");
      assert.equal(result.modelMetadata.apiSurface, "interactions");
      assert.equal(result.modelMetadata.responseModelVersion, null); // never invent the resolved version
      assert.deepEqual(result.audio, wav);
      assert.equal(result.mimeType, "audio/wav");
    });
  });

  test("TTS raw L16 response is wrapped; only the last model-output audio is selected", async () => {
    await mocked({ steps: [{ type: "user_input", content: [{ type: "audio", data: "invalid" }] }, { type: "model_output", content: [{ type: "text", text: "ignored" }, { type: "audio", data: "ignored" }, { type: "audio", mime_type: "audio/l16;rate=24000", data: "AAD/fw==" }] }] }, async () => {
      assert.deepEqual((await synthesizeSpeech(ttsText)).audio, wav);
    });
  });

  test("configured compatible models and voice are sent exactly, never substituted", async () => {
    await mocked(audioReply, async requests => {
      process.env.GEMINI_TTS_MODEL = "gemini-3.8-flash-lite-tts";
      process.env.GEMINI_TTS_VOICE = "Puck";
      await synthesizeSpeech(ttsText);
      assert.equal(requests[0].body.model, "gemini-3.8-flash-lite-tts");
      assert.deepEqual(requests[0].body.generation_config.speech_config, [{ voice: "Puck" }]);
    });
    await mocked(textReply, async requests => {
      process.env.GEMINI_MODEL = "gemini-3.6-flash";
      const result = await generate({ contents: [{ role: "user", parts: [{ text: "Synthetic" }] }], temperature: 0.1 });
      assert.match(requests[0].url, /models\/gemini-3\.6-flash:generateContent$/);
      assert.equal(result.modelMetadata.requestedModel, "gemini-3.6-flash");
      assert.equal(requests[0].body.generationConfig.temperature, undefined);
    });
  });

  test("media-resolution switch converts both internal forms without mutating input", async () => {
    const opts: GenerateOptions = { contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/jpeg", data: "AAAA" }, mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" } },
      { fileData: { mimeType: "video/webm", fileUri: "https://generativelanguage.googleapis.com/v1beta/files/synthetic" }, mediaResolution: "MEDIA_RESOLUTION_LOW" },
      { inlineData: { mimeType: "image/jpeg", data: "AAAA" } },
      { inlineData: { mimeType: "audio/webm", data: "AAAA" } }, { text: "Synthetic" },
    ] }] };
    const original = structuredClone(opts);
    await mocked(textReply, async requests => {
      process.env.GEMINI_MEDIA_RESOLUTION_FORM = "string";
      const stringResult = await generate(opts);
      assert.deepEqual(requests[0].body.contents[0].parts.map((p: any) => p.mediaResolution), ["MEDIA_RESOLUTION_HIGH", "MEDIA_RESOLUTION_LOW", "MEDIA_RESOLUTION_LOW", undefined, undefined]);
      process.env.GEMINI_MEDIA_RESOLUTION_FORM = "object";
      const objectResult = await generate(opts);
      assert.deepEqual(requests[1].body.contents[0].parts.map((p: any) => p.mediaResolution), [{ level: "MEDIA_RESOLUTION_HIGH" }, { level: "MEDIA_RESOLUTION_LOW" }, { level: "MEDIA_RESOLUTION_LOW" }, undefined, undefined]);
      assert.notEqual(stringResult.modelMetadata.configHash, objectResult.modelMetadata.configHash);
      assert.deepEqual(opts, original);
      process.env.GEMINI_MEDIA_RESOLUTION_FORM = "guess";
      await assert.rejects(() => generate(opts), GeminiConfigurationError);
      assert.equal(requests.length, 2);
    });
  });

  test("metadata hash is stable for identical effective requests and changes with the request", async () => {
    await mocked({ candidates: [] }, async () => {
      const contents = [{ role: "user" as const, parts: [{ text: "Synthetic" }] }];
      const a = await generate({ contents, temperature: 0.1 });
      const b = await generate({ temperature: 0.9, contents });
      assert.deepEqual(a.modelMetadata, b.modelMetadata); // omitted sampling cannot change the wire config
      const c = await generate({ contents, jsonOnly: true });
      assert.notEqual(a.modelMetadata.configHash, c.modelMetadata.configHash);
      assert.equal(a.modelMetadata.responseModelVersion, null);
    });
  });

  test("unsupported text, TTS and Live roles throw typed errors before transport", async () => {
    await mocked({}, async requests => {
      for (const model of ["gemini-3.8-flash", "gemini-3.8-live", "gemini-2.5-flash-preview-tts", "unknown"]) {
        process.env.GEMINI_TTS_MODEL = model;
        await assert.rejects(() => synthesizeSpeech(ttsText), GeminiCapabilityError);
      }
      for (const model of ["gemini-3.8-live", "gemini-3.8-flash-tts", "unknown"]) {
        process.env.GEMINI_MODEL = model;
        await assert.rejects(() => generate({ contents: [] }), GeminiCapabilityError);
      }
      assert.throws(() => liveMintConstraints("gemini-3.8-flash"), GeminiCapabilityError);
      assert.throws(() => buildLiveSetup({ model: "gemini-3.8-flash-tts", systemInstruction: "Synthetic" }), GeminiCapabilityError);
      assert.equal(requests.length, 0);
    });
    assert.doesNotThrow(() => assertGeminiCapability("gemini-3.8-live", "live"));
  });

  test("provider refusal is typed and does not trigger a model or API-surface fallback", async () => {
    await mocked({ error: "synthetic unsupported request" }, async requests => {
      await assert.rejects(() => synthesizeSpeech(ttsText), error => error instanceof GeminiApiError && error.status === 400 && error.model === "gemini-3.8-flash-tts");
      assert.equal(requests.length, 1);
      assert.match(requests[0].url, /\/interactions$/);
    }, 400);
  });

  test("TTS missing audio fails explicitly and PHI is blocked before either transport", async () => {
    await mocked({ steps: [] }, async requests => {
      await assert.rejects(() => synthesizeSpeech(ttsText), TtsAudioError);
      await assert.rejects(() => synthesizeSpeech("PatientName: DOE^JANE"), PhiError);
      await assert.rejects(() => generate({ contents: [{ role: "user", parts: [{ text: "PatientID: PRIVATE123" }] }] }), PhiError);
      assert.equal(requests.length, 1);
    });
  });

  test("ElevenLabs remains primary for enrolled discussion voice", async () => {
    await mocked({}, async requests => {
      process.env.ELEVENLABS_API_KEY = "synthetic-eleven-key";
      const result = await synthesizeTutorSpeech({ text: ttsText, voiceId: "synthetic-clone" });
      assert.equal(result?.provider, "elevenlabs");
      assert.equal(requests.length, 1);
      assert.match(requests[0].url, /^https:\/\/api\.elevenlabs\.io\//);
    });
  });

  test("3.8 request builders never pass deprecated sampling or put style in text", () => {
    const body = buildGenerateRequest({ contents: [], temperature: 0.15 }, "gemini-3.8-flash");
    assert.deepEqual(body.generationConfig, {});
    const tts = buildTtsRequest(ttsText, "gemini-3.8-flash-tts", "Kore");
    assert.equal(tts.input[0].content[0].text, ttsText);
    assert.equal(tts.input[0].content[0].annotations[0].type, "speech_metadata");
  });
});
