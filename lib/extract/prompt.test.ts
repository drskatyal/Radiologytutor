import test from "node:test";
import assert from "node:assert/strict";
import { extractionRequest, extractionClock, EXTRACT_SYSTEM } from "./prompt";
import { markerTrack } from "../anchors/fixtures";
import { newManifest } from "../journal/manifest";
import { buildGenerateRequest } from "../gemini";
import { parseExtraction } from "./schema";

test("M6 request snapshot: reviewed media, safe clock and offsets; no PHI, answer key or geometry context", () => {
  const journal = markerTrack().journal!;
  journal[1].payload!.diagnosis = "CANARY_DIAGNOSIS";
  journal[1].payload!.patientName = "DIRTY^SYNTHETIC";
  journal[0].payload!.answerKey = "CANARY_ANSWER";
  const manifest = { ...newManifest("synthetic", "take", "2026-11-12T00:00:00Z"), durationMs: 1000, offsets: { audio: 20, video: 10 }, phiReview: { pixels: true, audio: true, screen: true } };
  const request = extractionRequest({ manifest, journal, modelId: "gemini-3.8-flash", media: [{ inlineData: { mimeType: "audio/wav", data: "U1lOVEhFVElD" } }] });
  const clock = JSON.parse(request.contents[0].parts[0].text!);
  assert.deepEqual(clock, { durationMs: 1000, offsets: { audio: 20, video: 10 }, clock: [0, 1, 2].flatMap(i => [
    { seq: 2 * i, t: 100 * i, kind: "render", image: `image_${i + 1}`, ww: 400, wc: 40 },
    { seq: 2 * i + 1, t: 100 * i + 20, kind: "marker", image: `image_${i + 1}`, ww: 400, wc: 40, markerId: `marker-${i}` },
  ]) });
  const body = buildGenerateRequest(request, "gemini-3.8-flash");
  const payload = JSON.stringify(body);
  for (const value of ["CANARY", "DIRTY^SYNTHETIC", "1.2.3.4", "imagePoint", "patientPoint", '"temperature"', '"google_search"']) assert.ok(!payload.includes(value), value);
  assert.equal(request.model, "gemini-3.8-flash"); assert.equal(request.timeoutMs, 180000);
  assert.equal(request.systemInstruction!.startsWith(EXTRACT_SYSTEM), true);
  assert.deepEqual(body.generationConfig, { responseMimeType: "application/json" });
  assert.equal(body.tools, undefined);
  assert.deepEqual(extractionClock([{ seq: 0, t: 0, kind: "input", payload: { secret: "CANARY" } }]), []);
  assert.throws(() => extractionRequest({ manifest: newManifest("synthetic", "take"), journal, modelId: "gemini-3.8-flash", media: [] }), /PHI review/);
});

test("model schema is an allowlist; discarded field names and values never enter logs or output", () => {
  const logs: unknown[][] = [], saved = console.info; console.info = (...args) => { logs.push(args); };
  try {
    const result = parseExtraction({ patientName: "DIRTY^SYNTHETIC", findings: [{ label: "Synthetic focus", description: "Observe contour", teachingPoints: ["Compare sides"], dictatedOrVisual: "visual", confidence: .9,
      SOPInstanceUID: "MODEL_UID_CANARY", frame: 123, imagePoint: { x: 999, y: 100 }, measurements: [{ lengthMm: 999 }], PatientID: "MODEL_PATIENT_CANARY", "MODEL_KEY_CANARY": true,
      evidence: [{ tStart: 10, tEnd: 20, journalSeq: [1], coordinates: [100, 200] }], markerId: "marker-0" }] });
    const serialized = JSON.stringify([result, logs]);
    for (const value of ["DIRTY", "MODEL_UID_CANARY", "MODEL_PATIENT_CANARY", "MODEL_KEY_CANARY", "999", "coordinates"]) assert.ok(!serialized.includes(value), value);
    assert.ok(result.audit.some(a => a.category === "identity")); assert.ok(result.audit.some(a => a.category === "geometry")); assert.ok(result.audit.some(a => a.category === "patient"));
    assert.equal(result.proposals[0].evidence[0].tStart, 10);
    assert.throws(() => parseExtraction({ findings: [{ label: "PatientID: DIRTY_CANARY" }] }), /PHI review/);
    const absent = parseExtraction({ findings: [{ evidence: [{ tStart: "12", tEnd: null, journalSeq: [1, -2, "3"] }] }] });
    assert.deepEqual(absent.proposals[0].evidence, [{ tStart: null, tEnd: null, journalSeq: [1], estimated: true }]);
  } finally { console.info = saved; }
});
