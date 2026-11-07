import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLiveContextUpdate,
  buildLiveSetup,
  buildLiveToolResponse,
  downsampleToPcm16,
  liveMintConstraints,
  liveSessionInstruction,
  liveSessionKick,
  liveWebSocketUrl,
  parseLiveServerMessage,
  GEMINI_LIVE_WS_URL,
} from "./geminiLiveProtocol.ts";
import { livePackTools, materializeLiveTeachingPack } from "./liveTeachingPack.ts";
import type { Finding } from "./types.ts";

const nodule: Finding = {
  id: "f1",
  label: "Right upper lobe nodule",
  description: "Spiculated.",
  teachingPoints: ["Compare the prior."],
  state: " ",
  marker: { x_pct: 0.4, y_pct: 0.4, shape: "circle" },
  order: 1,
  seriesInstanceUID: "1.2.lung",
  sliceIndex: 34,
};

const PACK = materializeLiveTeachingPack({
  caseId: "lidc",
  modality: "CT",
  diagnosis: "Primary lung carcinoma",
  findings: [nodule],
});

test("live setup targets audio, search, and non-blocking tools without thinking", () => {
  const message = buildLiveSetup({
    model: "gemini-3.8-live",
    systemInstruction: "Teach on the study.",
    extra: {
      thinking_level: "high",
      thinkingConfig: { thinkingLevel: "low" },
      proactive_audio: false,
      enable_affective_dialog: true,
      generationConfig: { thinking_level: "minimal", temperature: 0.4 },
    },
  });
  const setup = message.setup;
  const encoded = JSON.stringify(message);
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.deepEqual(setup.responseModalities, ["AUDIO"]);
  assert.equal(encoded.includes("thinking_level"), false);
  assert.equal(encoded.includes("thinkingLevel"), false);
  assert.equal(encoded.includes("thinkingConfig"), false);
  assert.equal(encoded.includes("thinking_config"), false);
  assert.equal(encoded.includes("proactive_audio"), false);
  assert.equal(encoded.includes("enable_affective_dialog"), false);
  assert.equal(encoded.includes('"BLOCKING"'), false);
  assert.match(encoded, /NON_BLOCKING/);
  assert.match(encoded, /web_search/);
  assert.match(encoded, /set_series/);
  assert.match(encoded, /show_finding/);
  assert.equal(encoded.includes("play_guide"), false);
  assert.equal(encoded.includes("google_search"), false);
  assert.match(encoded, /inputAudioTranscription/);
  assert.match(encoded, /outputAudioTranscription/);
  const generation = setup.generationConfig as { temperature?: number };
  assert.equal(generation.temperature, 0.4);
});

test("live setup drops viewport video even if a caller attaches it", () => {
  const message = buildLiveSetup({
    model: "gemini-3.8-live",
    systemInstruction: "Teach on the study.",
    extra: {
      video: { mimeType: "video/webm", data: "AAAA" },
      contents: [
        {
          parts: [
            { text: "look" },
            { inlineData: { mimeType: "video/webm", data: "AAAA" } },
            { fileData: { mimeType: "video/webm", fileUri: "https://example.invalid/v" } },
          ],
        },
      ],
    },
  });
  const encoded = JSON.stringify(message);
  assert.equal(encoded.includes("video/webm"), false);
  assert.equal(encoded.includes("inlineData"), false);
  assert.equal(encoded.includes("fileData"), false);
  assert.equal(encoded.includes("AAAA"), false);
  assert.match(encoded, /Teach on the study/);
});

test("mint constraints lock the model and audio and omit thinking", () => {
  const constraints = liveMintConstraints("gemini-3.8-live");
  assert.equal(constraints.model, "models/gemini-3.8-live");
  assert.deepEqual(constraints.config.responseModalities, ["AUDIO"]);
  assert.equal(JSON.stringify(constraints).includes("thinking"), false);
});

test("ephemeral socket url carries the token and not an API key", () => {
  const url = liveWebSocketUrl(GEMINI_LIVE_WS_URL, "auth_tokens/abc def");
  assert.match(url, /BidiGenerateContentConstrained/);
  assert.match(url, /access_token=auth_tokens%2Fabc\+def|access_token=auth_tokens%2Fabc%20def/);
  assert.equal(url.includes("key="), false);
});

test("teach and examiner instructions forbid scroll-started teaching", () => {
  const teach = liveSessionInstruction({ pack: PACK, mode: "teach_me", caseTitle: "LIDC" });
  const exam = liveSessionInstruction({ pack: PACK, mode: "examiner", caseTitle: "LIDC" });
  assert.match(teach, /Scrolling does not start teaching/);
  assert.match(teach, /f1/);
  assert.match(teach, /Teach me the case/);
  assert.match(teach, /set_series/);
  assert.match(exam, /ACTIVE MODE: Examiner/);
  assert.match(exam, /Ask one question/);
  assert.equal(exam.includes("Primary lung carcinoma"), false);
  assert.match(liveSessionKick("teach_me"), /Teach me this case/);
  assert.match(liveSessionKick("examiner"), /examiner/i);
  assert.equal(teach.includes("1.2.lung"), false);
  assert.equal(teach.includes("34"), false);
});

test("server messages yield audio, captions, tools, and search sources", () => {
  const events = parseLiveServerMessage(
    JSON.stringify({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAA" } }],
        },
        inputTranscription: { text: "What is this?" },
        outputTranscription: { text: "Look at this slice." },
        groundingMetadata: {
          groundingChunks: [{ web: { uri: "https://example.test/fleischner", title: "Fleischner" } }],
        },
        turnComplete: true,
      },
      toolCall: {
        functionCalls: [{ id: "c1", name: "show_finding", args: { findingId: "f1" } }],
      },
    })
  );
  assert.equal(events.some((event) => event.type === "audio" && event.sampleRate === 24000), true);
  assert.equal(events.some((event) => event.type === "inputTranscript"), true);
  assert.equal(events.some((event) => event.type === "outputTranscript"), true);
  assert.equal(events.some((event) => event.type === "turnComplete"), true);
  const tools = events.find((event) => event.type === "toolCall");
  assert.equal(tools && tools.type === "toolCall" && tools.calls[0]?.name, "show_finding");
  const sources = events.find((event) => event.type === "sources");
  assert.equal(sources && sources.type === "sources" && sources.sources[0]?.title, "Fleischner");
});

test("context update replaces the instruction and sends the full tool list", () => {
  const message = JSON.parse(
    buildLiveContextUpdate({
      systemInstruction: liveSessionInstruction({ pack: PACK, mode: "examiner", caseTitle: "LIDC" }),
      tools: livePackTools(PACK.authoredSeriesInstanceUIDs),
    })
  );
  const names = message.contextUpdate.tools.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name);
  assert.equal(message.contextUpdate.systemInstruction.parts[0].text.includes("Primary lung carcinoma"), false);
  assert.equal(message.contextUpdate.systemInstruction.parts[0].text.includes("1.2.lung"), false);
  assert.ok(names.includes("set_series"));
  assert.ok(names.includes("web_search"));
  assert.ok(names.includes("show_finding"));
  assert.equal(names.includes("play_guide"), false);
  assert.match(JSON.stringify(message), /NON_BLOCKING/);
});

test("tool responses keep the call id and downsample to 16 kHz", () => {
  const payload = JSON.parse(buildLiveToolResponse([{ id: "c1", name: "set_series", response: { ok: true } }]));
  assert.equal(payload.toolResponse.functionResponses[0].id, "c1");
  const pcm = downsampleToPcm16(new Float32Array([0, 0.5, 0, -0.5]), 32000, 16000);
  assert.equal(pcm.length, 2);
  assert.ok(pcm[0]! > 0);
  assert.ok(pcm[1]! < 0);
});
