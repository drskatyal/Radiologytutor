import { test } from "node:test";
import assert from "node:assert/strict";
import { getObjectUrl, getSignedGetUrl, putObject, r2Configured, resolveObjectStore } from "./r2.ts";

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

test("resolveObjectStore keeps the Cloudflare endpoint when R2_ENDPOINT is unset", () => {
  assert.deepEqual(
    resolveObjectStore({
      accountId: "acct",
      accessKeyId: "key",
      secretAccessKey: "secret",
      bucket: "frames",
    }),
    { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "frames" }
  );
});

test("resolveObjectStore uses R2_ENDPOINT without an account id (GCS HMAC)", () => {
  assert.deepEqual(
    resolveObjectStore({
      accessKeyId: "key",
      secretAccessKey: "secret",
      bucket: "flowrad-frames",
      endpoint: "https://storage.googleapis.com/",
    }),
    { endpoint: "https://storage.googleapis.com", bucket: "flowrad-frames" }
  );
});

test("resolveObjectStore is null without a bucket", () => {
  assert.equal(
    resolveObjectStore({
      endpoint: "https://storage.googleapis.com",
      accessKeyId: "key",
      secretAccessKey: "secret",
    }),
    null
  );
});
