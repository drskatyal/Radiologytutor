import { test } from "node:test";
import assert from "node:assert/strict";
import { STRUCTURE_FINDING_SYSTEM, STRUCTURE_SESSION_SYSTEM } from "./teachingPrompt.ts";
import { markerNearTime, segmentMidMs, sliceNearTime } from "./captureSession.ts";
import { AGENTIC_VIDEO_MIN_MS } from "./compileMedia.ts";
import {
  compileSessionRequest,
  compileStructuredSession,
  findingSystemInstruction,
  type CompileGenerate,
} from "./compileSession.ts";
import type { CompileFrame } from "./compileMedia.ts";
import type { RecordedTrack } from "./types.ts";

const jpeg = "A".repeat(48);

const track: RecordedTrack = {
  durationMs: 4000,
  start: { sliceIndex: 0, ww: 400, wc: 40 },
  events: [
    { t: 100, type: "cursor", x: 0.2, y: 0.3 },
    { t: 500, type: "slice", index: 2 },
    { t: 800, type: "cursor", x: 0.55, y: 0.4 },
    { t: 1200, type: "camera", zoom: 2.2, pan: [10, -4] },
    { t: 1500, type: "voi", ww: 1500, wc: -600 },
    { t: 2000, type: "slice", index: 4 },
    { t: 2500, type: "cursor", x: 0.7, y: 0.6 },
    { t: 3200, type: "slice", index: 9 },
  ],
};

const frames: CompileFrame[] = [
  { tMs: 800, mimeType: "image/jpeg", base64: jpeg },
  { tMs: 2600, mimeType: "image/jpeg", base64: "B".repeat(48) },
];

function modelJson() {
  return JSON.stringify({
    transcript: "Left lower lobe nodule, then a right pleural effusion.",
    findings: [
      {
        label: "Left lower lobe nodule",
        description: "Solid nodule on the lung window.",
        teachingPoints: ["Check the prior."],
        whatToNotice: "A round opacity on lung windows.",
        pearl: "Check the prior.",
        mimics: ["Vessel"],
        clinicalImportance: 1,
        whyClinicallyFirst: "It could be cancer.",
        reportLine: "Solid left lower lobe nodule.",
        landmark: "left lower lobe",
        seriesInstanceUID: "1.2.3.evil",
        sliceIndex: 99,
        windowWidth: 1,
        windowCenter: 1,
        tStartMs: 400,
        tEndMs: 1800,
        suggestedMarker: { x_pct: 0.99, y_pct: 0.01, shape: "circle" },
        suggestedSliceIndex: 99,
        teachingGuide: {
          beats: [{ t: 0, act: "commit", actions: [{ type: "point", x: 0.99, y: 0.01 }], say: "Invented." }],
        },
      },
      {
        label: "Right pleural effusion",
        description: "Dependent opacity.",
        teachingPoints: [],
        tStartMs: 2200,
        tEndMs: 3600,
        suggestedMarker: { x_pct: 0.02, y_pct: 0.02, shape: "circle" },
        suggestedSliceIndex: 1,
      },
    ],
  });
}

test("compile request sends stills and audio through the shared Flash parts", () => {
  const request = compileSessionRequest({
    audioBase64: "AUDIODATA",
    audioMime: "audio/webm",
    durationMs: 4000,
    track,
    frames,
  });

  assert.equal(request.systemInstruction.startsWith(STRUCTURE_SESSION_SYSTEM), true);
  assert.match(request.systemInstruction, /Viewport still/);
  assert.match(request.systemInstruction, /Do NOT output pixel coordinates/i);
  assert.doesNotMatch(request.systemInstruction, /gemini-3\.8|3\.8-flash/);

  const inline = request.parts.flatMap((part) => (part.inlineData ? [part.inlineData] : []));
  assert.deepEqual(
    inline.map((part) => part.mimeType),
    ["image/jpeg", "image/jpeg", "audio/webm"]
  );
  assert.equal(inline[2]?.data, "AUDIODATA");
  const text = request.parts.map((part) => part.text ?? "").join("\n");
  assert.match(text, /Viewport still at t=800ms/);
  assert.match(text, /Do not include coordinates or slice indices/);
  assert.doesNotMatch(text, /0\.55/);
  assert.doesNotMatch(text, /0\.99/);
  assert.match(text, /t=800ms pointer/);
});

test("audio-only compile keeps the session prompt and still hides pointer coordinates", () => {
  const request = compileSessionRequest({
    audioBase64: "AUDIODATA",
    audioMime: "audio/webm",
    durationMs: 4000,
    track,
  });
  assert.equal(request.systemInstruction, STRUCTURE_SESSION_SYSTEM);
  assert.equal(
    request.parts.some((part) => part.inlineData?.mimeType.startsWith("image/")),
    false
  );
  const text = request.parts.map((part) => part.text ?? "").join("\n");
  assert.match(text, /Transcribe \(if needed\) and segment into teaching findings/);
  assert.doesNotMatch(text, /0\.55/);
});

test("finding prompt is unchanged unless viewport stills are attached", () => {
  assert.equal(findingSystemInstruction(false), STRUCTURE_FINDING_SYSTEM);
  assert.match(findingSystemInstruction(true), /Viewport stills/);
  assert.match(findingSystemInstruction(true), /Do not invent/);
});

test("compile anchors markers and slices from the track clock and rebuilds the teach script", async () => {
  let seenJson = false;
  const generate: CompileGenerate = async (opts) => {
    seenJson = opts.jsonOnly === true;
    assert.equal(opts.temperature, 0.15);
    const types = opts.contents[0]?.parts.flatMap((part) =>
      part.inlineData ? [part.inlineData.mimeType] : []
    );
    assert.deepEqual(types, ["image/jpeg", "image/jpeg", "audio/webm"]);
    return { text: modelJson() };
  };

  const session = await compileStructuredSession(
    {
      audioBase64: "AUDIODATA",
      audioMime: "audio/webm",
      durationMs: track.durationMs,
      track,
      frames,
    },
    generate
  );

  assert.equal(seenJson, true);
  assert.equal(session.transcript, "Left lower lobe nodule, then a right pleural effusion.");
  assert.equal(session.findings.length, 2);

  const nodule = session.findings[0];
  const mid = segmentMidMs(400, 1800);
  assert.deepEqual(nodule.suggestedMarker, markerNearTime(track, mid));
  assert.equal(nodule.suggestedSliceIndex, sliceNearTime(track, mid));
  assert.notEqual(nodule.suggestedMarker?.x_pct, 0.99);
  assert.notEqual(nodule.suggestedSliceIndex, 99);
  assert.equal(nodule.whatToNotice, "A round opacity on lung windows.");
  assert.equal(nodule.pearl, "Check the prior.");
  assert.equal(nodule.clinicalImportance, 1);
  assert.equal(nodule.whyClinicallyFirst, "It could be cancer.");
  assert.equal("seriesInstanceUID" in nodule, false);
  assert.equal("windowWidth" in nodule, false);

  const acts = nodule.teachingGuide?.beats.map((beat) => beat.act);
  assert.deepEqual(acts, ["orient", "search", "lean-in", "commit", "pearl"]);
  const point = nodule.teachingGuide?.beats
    .flatMap((beat) => beat.actions)
    .find((action) => action.type === "point");
  assert.equal(point?.type, "point");
  if (point?.type === "point") {
    assert.equal(point.x, 0.55);
    assert.equal(point.y, 0.4);
  }

  const effusion = session.findings[1];
  const mid2 = segmentMidMs(2200, 3600);
  assert.deepEqual(effusion.suggestedMarker, markerNearTime(track, mid2));
  assert.equal(effusion.suggestedSliceIndex, sliceNearTime(track, mid2));
  assert.equal(effusion.suggestedSliceIndex, 4);
  assert.equal(session.liveTeachingPack?.findings[0]?.drive.sliceIndex, nodule.suggestedSliceIndex);
  assert.equal(JSON.stringify(session.liveTeachingPack).includes("1.2.3.evil"), false);
  assert.equal(session.liveTeachingPack?.findings[0]?.drive.sliceIndex === 99, false);
  assert.equal(session.liveTeachingPack?.findings[0]?.whatToNotice, "A round opacity on lung windows.");
});

test("long viewer recordings use agentic video and skip the still strip", () => {
  const longTake = compileSessionRequest({
    audioBase64: "AUDIODATA",
    audioMime: "audio/webm",
    durationMs: AGENTIC_VIDEO_MIN_MS,
    track,
    frames,
    video: { base64: "VIDEO", mimeType: "video/webm" },
  });
  const video = longTake.parts.find((part) => part.inlineData?.mimeType === "video/webm");
  assert.equal(video?.mediaProcessing, "AGENTIC");
  assert.equal(video?.inlineData?.data, "VIDEO");
  assert.equal(
    longTake.parts.some((part) => part.inlineData?.mimeType.startsWith("image/")),
    false
  );

  const shortTake = compileSessionRequest({
    audioBase64: "AUDIODATA",
    audioMime: "audio/webm",
    durationMs: 30_000,
    track,
    frames,
    video: { base64: "VIDEO", mimeType: "video/webm" },
  });
  const shortVideo = shortTake.parts.find((part) => part.inlineData?.mimeType === "video/webm");
  assert.equal(shortVideo?.mediaProcessing, "STATIC");
  assert.equal(
    shortTake.parts.some((part) => part.inlineData?.mimeType === "image/jpeg"),
    true
  );
});

test("compile ignores model coordinates when the take has no viewer track", async () => {
  const generate: CompileGenerate = async () => ({ text: modelJson() });
  const session = await compileStructuredSession(
    { transcript: "Spoken notes only.", durationMs: 4000 },
    generate
  );
  assert.equal(session.findings[0]?.suggestedMarker, undefined);
  assert.equal(session.findings[0]?.suggestedSliceIndex, undefined);
  assert.equal(session.findings[0]?.teachingGuide, undefined);
  assert.equal(session.transcript, "Left lower lobe nodule, then a right pleural effusion.");
});

test("compile partitions missing times and still lands them on the track", async () => {
  const generate: CompileGenerate = async () => ({
    text: JSON.stringify({
      transcript: "",
      findings: [
        { label: "First", description: "A", teachingPoints: [] },
        { label: "Second", description: "B", teachingPoints: ["Pearl"] },
      ],
    }),
  });
  const session = await compileStructuredSession(
    { audioBase64: "AUDIODATA", durationMs: 4000, track },
    generate
  );
  assert.equal(session.transcript, "");
  assert.deepEqual(
    session.findings.map((finding) => [finding.tStartMs, finding.tEndMs]),
    [
      [0, 2000],
      [2000, 4000],
    ]
  );
  assert.equal(session.findings[1]?.suggestedSliceIndex, sliceNearTime(track, 3000));
  assert.deepEqual(session.findings[1]?.suggestedMarker, markerNearTime(track, 3000));
  assert.ok(session.findings[0]?.teachingGuide?.beats.length);
});

test("compile refuses a body with neither audio nor transcript", async () => {
  await assert.rejects(
    () => compileStructuredSession({ durationMs: 1000, track }, async () => ({ text: "{}" })),
    /audioBase64 or transcript is required/
  );
});
