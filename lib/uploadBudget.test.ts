import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { middleware } from "../middleware.ts";

const MB = 1024 * 1024;

function post(path: string, extra?: { contentLength?: number; cookie?: string }) {
  const headers = new Headers();
  if (extra?.contentLength != null) headers.set("content-length", String(extra.contentLength));
  if (extra?.cookie) headers.set("cookie", extra.cookie);
  return new NextRequest(new URL(path, "http://127.0.0.1"), { method: "POST", headers });
}

test("a multi-file DICOM upload is not rate limited and still rejects an oversized body", async () => {
  const cookie = "flowrad_demo=upload-budget-test";
  for (let i = 0; i < 65; i++) {
    const res = middleware(post("/api/upload", { cookie, contentLength: 1024 }));
    assert.equal(res.status, 200, `upload request ${i + 1}`);
  }
  const atCap = middleware(post("/api/upload", { cookie, contentLength: 512 * MB }));
  assert.equal(atCap.status, 200);
  const huge = middleware(post("/api/upload", { cookie, contentLength: 512 * MB + 1 }));
  assert.equal(huge.status, 413);
  const body = (await huge.json()) as { error?: string; maxBytes?: number };
  assert.match(body.error ?? "", /too large/i);
  assert.equal(body.maxBytes, 512 * MB);
});

test("AI and auth routes stay rate limited", async () => {
  const cookie = "flowrad_demo=tutor-budget-test";
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++) {
    statuses.push(middleware(post("/api/tutor", { cookie, contentLength: 128 })).status);
  }
  assert.deepEqual(
    statuses.slice(0, 20).every((s) => s === 200),
    true
  );
  assert.equal(statuses[20], 429);
  const again = middleware(post("/api/tts", { cookie: "flowrad_demo=tts-budget-test", contentLength: 64 }));
  assert.equal(again.status, 200);
  const demo = middleware(
    post("/api/auth/demo", { cookie: "flowrad_demo=demo-budget-test", contentLength: 32 })
  );
  assert.equal(demo.status, 200);
  const limited = middleware(post("/api/tutor", { cookie, contentLength: 128 }));
  assert.equal(limited.status, 429);
  const body = (await limited.json()) as { error?: string };
  assert.match(body.error ?? "", /Too many requests/);
});
