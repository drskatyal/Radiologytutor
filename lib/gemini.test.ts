import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { generate, runTeachingPlan, type FunctionDeclaration } from "./gemini.ts";
import { splitSentences } from "./performancePlan.ts";

const showFinding: FunctionDeclaration = {
  name: "show_finding",
  description: "Drive the viewer to a finding.",
  parameters: {
    type: "object",
    properties: { findingId: { type: "string" } },
    required: ["findingId"],
  },
};

/**
 * Capture the JSON body `generate` POSTs. Restores fetch and GEMINI_API_KEY.
 * The suite is serial so the global fetch mock cannot race.
 */
async function postedBody(opts: Parameters<typeof generate>[0]): Promise<Record<string, unknown>> {
  const prevKey = process.env.GEMINI_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  let raw = "";
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    raw = String(init?.body ?? "");
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
  try {
    await generate(opts);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

const contents = [{ role: "user" as const, parts: [{ text: "What is this?" }] }];

describe("generate request tools", { concurrency: 1 }, () => {
  test("Search plus function declarations enables server-side tool invocations", async () => {
    const body = await postedBody({
      contents,
      tools: [showFinding],
      googleSearch: true,
    });

    const tools = body.tools as Record<string, unknown>[];
    assert.ok(Array.isArray(tools));
    assert.deepEqual(
      tools.map((entry) => Object.keys(entry)[0]),
      ["functionDeclarations", "google_search"]
    );
    // generateContent REST JSON (camelCase), same shape as generationConfig.
    // Proto name in Google's 400: tool_config.include_server_side_tool_invocations.
    assert.deepEqual(body.toolConfig, { includeServerSideToolInvocations: true });
  });

  test("Search alone does not set the combination flag", async () => {
    const body = await postedBody({ contents, googleSearch: true });
    assert.deepEqual(body.tools, [{ google_search: {} }]);
    assert.equal(body.toolConfig, undefined);
  });

  test("function declarations alone do not set the combination flag", async () => {
    const body = await postedBody({ contents, tools: [showFinding] });
    assert.deepEqual(body.tools, [{ functionDeclarations: [showFinding] }]);
    assert.equal(body.toolConfig, undefined);
  });

  test("an empty function list is not combined with Search", async () => {
    const body = await postedBody({ contents, tools: [], googleSearch: true });
    assert.deepEqual(body.tools, [{ google_search: {} }]);
    assert.equal(body.toolConfig, undefined);
  });
});

describe("runTeachingPlan spoken answer", { concurrency: 1 }, () => {
  const finding = {
    id: "f_ptx",
    label: "Right apical pneumothorax",
    description: "Visceral pleural line at the apex.",
    teachingPoints: ["Do not call it a skin fold."],
    order: 0,
  };

  async function withGemini(
    parts: unknown[],
    run: () => Promise<void>
  ): Promise<void> {
    const prevKey = process.env.GEMINI_API_KEY;
    const prevFetch = globalThis.fetch;
    process.env.GEMINI_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
    }
  }

  test("tools with an empty message get a drive-first authored line", async () => {
    await withGemini(
      [
        { functionCall: { name: "scroll_to", args: { sliceIndex: 8, findingId: "f_ptx" } } },
        { functionCall: { name: "set_window", args: { windowWidth: 1500, windowCenter: -600 } } },
        { functionCall: { name: "point_to", args: { anchorId: "approved-ptx" } } },
      ],
      async () => {
        const result = await runTeachingPlan({
          question: "Teach the finding now on screen.",
          history: [],
          caseTitle: "LIDC nodule search",
          modality: "CT",
          mode: "guided",
          findingsContext: "id=f_ptx",
          currentFindingId: "f_ptx",
          approvedTools: {
            series: [{ studyUID: "study", seriesUID: "series", frameCount: 9, frames: Array.from({ length: 9 }, (_, i) => ({ studyUID: "study", seriesUID: "series", sopUID: `sop-${i}`, frame: 1 })) }],
            anchors: [{ id: "approved-ptx", findingId: "f_ptx", target: { studyUID: "study", seriesUID: "series", sopUID: "sop-8", frame: 1 }, point: { x: 0.5, y: 0.5 } }], annotations: [],
          },
          findings: [finding],
        });
        assert.equal(result.actions.length, 3);
        const sentences = splitSentences(result.answer);
        assert.match(sentences[0] ?? "", /^(Look|See|Watch|Follow)\b/);
        for (let i = 0; i < result.actions.length; i++) {
          assert.doesNotMatch(sentences[i] ?? "", /pneumothorax|pleural|skin fold/i);
        }
        assert.match(result.answer, /Right apical pneumothorax/);
        assert.match(result.answer, /Visceral pleural line at the apex/);
        assert.match(result.answer, /Do not call it a skin fold/);
      }
    );
  });

  // Strategy §4 M1 supersedes the old hint/reveal ladder: answers must never
  // reach the exam model, including after repeated hints or a give-up request.
  for (const mode of ["socratic", "viva"] as const) {
    test(`${mode} never sends teaching context or reveals on hints/give-up`, async () => {
      const previous = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = (async () => { calls++; throw new Error("Exam must not call the teaching model"); }) as typeof fetch;
      try {
        for (const question of ["What is this?", "still not sure", "give me a hint", "I don't know; show and teach the finding"]) {
          const result = await runTeachingPlan({
            question, mode, caseTitle: "CANARY_TITLE", modality: "CT",
            findingsContext: "CANARY_RUBRIC", findings: [finding], currentFindingId: finding.id,
            history: [{ role: "assistant", text: "CANARY_PRIOR_ANSWER" }],
          });
          assert.equal(result.answer, "Describe what you see on this series.");
          assert.doesNotMatch(JSON.stringify(result), /CANARY|pneumothorax|pleural|skin fold/i);
          assert.deepEqual(result.actions, []);
          assert.deepEqual(result.action, { type: "none" });
          assert.deepEqual(result.sources, []);
        }
        assert.equal(calls, 0);
      } finally { globalThis.fetch = previous; }
    });
  }

  test("a spoken answer from the model is kept", async () => {
    await withGemini([{ text: "Look at this slice. The pleural line is continuous." }], async () => {
      const result = await runTeachingPlan({
        question: "What is this?",
        history: [],
        caseTitle: "LIDC nodule search",
        modality: "CT",
        mode: "guided",
        findingsContext: "id=f_ptx",
        findings: [finding],
      });
      assert.equal(result.answer, "Look at this slice. The pleural line is continuous.");
      assert.equal(result.actions.length, 0);
    });
  });
});
