import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// scripts/vosk-csp-patch.cjs: the recognizer worker must contain no code built
// from strings (the desktop CSP has no 'unsafe-eval'). The 0.8.0 hang came from
// embind's `new Function`; the first patch missed its `new_(Function, …)` form.
const require = createRequire(__filename);
const { patchVoskSource } = require("../scripts/vosk-csp-patch.cjs") as { patchVoskSource: (s: string) => string };
const VOSK = path.join(__dirname, "..", "node_modules", "vosk-browser", "dist", "vosk.js");

const workerOf = (source: string) =>
  Buffer.from(source.match(/createBase64WorkerFactory\('([A-Za-z0-9+/=]+)'/)![1]!, "base64").toString("utf8");

test("the patched recognizer worker builds no code from strings, and the patch is idempotent", { skip: !fs.existsSync(VOSK) }, () => {
  const original = fs.readFileSync(VOSK, "utf8");
  assert.match(workerOf(original), /new_\(Function,/, "the unpatched worker uses new_(Function, …)");
  const patched = patchVoskSource(original);
  const worker = workerOf(patched);
  for (const pattern of [/\bnew Function\b/, /new_\(Function\b/, /[^\w.$]Function\(/, /[^.\w$]eval\(/]) {
    assert.doesNotMatch(worker, pattern, String(pattern));
  }
  assert.ok(worker.includes("function craftInvokerFunction("));
  assert.ok(worker.includes("function __emval_get_method_caller("));
  assert.equal(patchVoskSource(patched), patched);
});
