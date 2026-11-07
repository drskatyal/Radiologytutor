import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadGeminiFile } from "./geminiFiles.ts";

test("files upload waits until the viewport video is ACTIVE", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/upload/v1beta/files")) {
      return new Response("{}", {
        status: 200,
        headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/session" },
      });
    }
    if (url.endsWith("/upload/session")) {
      return Response.json({
        file: {
          name: "files/viewport",
          uri: "https://generativelanguage.googleapis.com/v1beta/files/viewport",
          mimeType: "video/webm",
          state: "PROCESSING",
        },
      });
    }
    return Response.json({
      name: "files/viewport",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/viewport",
      mimeType: "video/webm",
      state: "ACTIVE",
    });
  };

  const uploaded = await uploadGeminiFile({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "video/webm",
    apiKey: "test-key",
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(uploaded.uri, "https://generativelanguage.googleapis.com/v1beta/files/viewport");
  assert.equal(uploaded.mimeType, "video/webm");
  assert.ok(calls.some((call) => call.includes("X-Goog-Upload-Command") || call.startsWith("POST")));
  assert.equal(calls.filter((call) => call.startsWith("GET")).length, 1);
});
