import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { generate, type FunctionDeclaration } from "./gemini.ts";

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
