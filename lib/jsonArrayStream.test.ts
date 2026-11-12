import assert from "node:assert/strict";
import { test } from "node:test";

import { JsonArrayScanner } from "./jsonArrayStream.ts";

function parseChunks(chunks: string[]): unknown[] {
  const scanner = new JsonArrayScanner();
  const out: unknown[] = [];
  for (const chunk of chunks) out.push(...scanner.push(chunk));
  return out;
}

test("a JSON array yields each object as soon as it closes", () => {
  const items = parseChunks(['[{"SOPInstanceUID":"1.2"},{"SOP', 'InstanceUID":"1.3"}]']);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { SOPInstanceUID: "1.2" });
  assert.deepEqual(items[1], { SOPInstanceUID: "1.3" });
});

test("braces and escapes inside strings do not end an object", () => {
  const items = parseChunks(['[{"note":"brace } and \\"quote\\""},{"n":2}]']);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { note: 'brace } and "quote"' });
  assert.deepEqual(items[1], { n: 2 });
});

test("an empty array and a single object both complete", () => {
  assert.deepEqual(parseChunks(["[]"]), []);
  assert.deepEqual(parseChunks(['{"a":1}']), [{ a: 1 }]);
});
