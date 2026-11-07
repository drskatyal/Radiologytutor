import assert from "node:assert/strict";
import { test } from "node:test";

import { stackOpenIndex } from "./stackIndex.ts";

test("stack opens at the middle frame the viewer setStack uses", () => {
  assert.equal(stackOpenIndex(0), 0);
  assert.equal(stackOpenIndex(1), 0);
  assert.equal(stackOpenIndex(2), 1);
  // Public LIDC stack is 65 frames; the viewport opens on index 32.
  assert.equal(stackOpenIndex(65), 32);
});
