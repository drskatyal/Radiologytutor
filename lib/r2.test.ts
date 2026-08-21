import { test } from "node:test";
import assert from "node:assert/strict";
import { getObjectUrl, getSignedGetUrl, putObject, r2Configured } from "./r2.ts";

test("r2Configured is false when R2 env is unset", () => {
  assert.equal(r2Configured(), false);
});

test("putObject no-ops when R2 is unset", async () => {
  const result = await putObject("audio/test.webm", Buffer.from("x"), "audio/webm");
  assert.equal(result, null);
});

test("getObjectUrl is null without R2_PUBLIC_BASE_URL", () => {
  assert.equal(getObjectUrl("frames/a.dcm"), null);
});

test("getSignedGetUrl is null when R2 is unset", async () => {
  assert.equal(await getSignedGetUrl("audio/test.webm"), null);
});
