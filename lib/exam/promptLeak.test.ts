import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "../../fixtures/synthetic/case.json";
import type { CaseData } from "../types";
import { materializeLiveTeachingPack, livePackInstruction, livePackTools } from "../liveTeachingPack";
import { buildLiveSetup, buildLiveContextUpdate } from "../geminiLiveProtocol";
import { runTeachingPlan } from "../gemini";
import { examinerPromptPack } from "./prompt";
import { answerStructureRequest, structureAnswer } from "./structureAnswer";

test("all examiner prompt/setup builders exclude the answer, tools and search", () => {
  const data = fixture as CaseData;
  const pack = materializeLiveTeachingPack({ caseId: data.caseId, modality: "CT", findings: data.findings, diagnosis: "CANARY_DIAGNOSIS", clinicalQuestion: "CANARY_STEM" });
  const prompt = livePackInstruction(pack, "examiner", "CANARY_TITLE", "CANARY_FOCUS");
  const setup = buildLiveSetup({ model: "gemini-3.8-live", mode: "examiner", systemInstruction: "CANARY_INJECT", tools: livePackTools([]), extra: { google_search: {}, contents: "CANARY_EXTRA" } });
  for (const value of [examinerPromptPack(), prompt, setup, buildLiveContextUpdate({ mode: "examiner", systemInstruction: "CANARY_INJECT", tools: livePackTools([]) }), livePackTools([], "examiner"), answerStructureRequest("A round opacity is present.")]) {
    assert.doesNotMatch(JSON.stringify(value), /CANARY|show_finding|jump_to_key_view|play_guide|google_search|web_search/);
  }
});
test("exam structuring sends only learner text; invented claims and scoring fields are discarded", async () => {
  const text = "A round opacity is present. No effusion.";
  const claims = await structureAnswer(text, async request => {
    assert.deepEqual(request.contents, [{ role: "user", parts: [{ text }] }]);
    assert.equal(request.googleSearch, undefined);
    assert.equal(request.tools, undefined);
    return { text: JSON.stringify({ claims: [{ text: "A round opacity is present", negated: false, score: 100 }, { text: "CANARY_ANSWER", negated: false }, { text: "No effusion", negated: false }] }) };
  });
  assert.deepEqual(claims, [{ text: "A round opacity is present", negated: false }, { text: "No effusion", negated: true }]);
});
test("legacy exam tutor entry cannot send answer-bearing context to a model", async () => {
  const result = await runTeachingPlan({ question: "Explain", mode: "viva", caseTitle: "CANARY_TITLE", modality: "CT", history: [{ role: "assistant", text: "CANARY_ANSWER" }], findingsContext: "CANARY_RUBRIC" });
  assert.equal(result.answer, "Describe what you see on this series.");
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.sources, []);
});
