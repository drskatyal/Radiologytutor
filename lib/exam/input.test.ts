import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExamAnswer } from "./input";
import { PhiError } from "../phiGuard";
test("exam answer boundary checks transcribed identifiers before persistence or inference", () => {
  for (const text of ["Patient name: DOE^JANE", "Patient ID: ACC12345", "Accession: ACC12345", "Referring physician: DOE^JANE"]) assert.throws(() => parseExamAnswer({ kind: "text", text }), PhiError);
  assert.deepEqual(parseExamAnswer({ kind: "text", text: " A round opacity. " }), { kind: "text", text: "A round opacity." });
});
test("exam audio cannot bypass the reviewed text-only entry point", () => {
  for (const field of ["audio", "inlineData", "fileData"]) assert.throws(() => parseExamAnswer({ kind: "text", text: "normal", [field]: { data: "synthetic" } }), /reviewed transcript/);
  assert.throws(() => parseExamAnswer({ kind: "audio", data: "synthetic" }), /Invalid answer/);
});
