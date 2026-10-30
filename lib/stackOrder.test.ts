import { test } from "node:test";
import assert from "node:assert/strict";
import { sortAxialStack } from "./stackOrder.ts";

test("axial stacks are ordered cranial-first along the slice normal", () => {
  const abdomen = {
    "00200032": { Value: [0, 0, -384] },
    "00200037": { Value: [1, 0, 0, 0, 1, 0] },
    "00080018": { Value: ["abdomen"] },
  };
  const chest = {
    "00200032": { Value: [0, 0, -220] },
    "00200037": { Value: [1, 0, 0, 0, 1, 0] },
    "00080018": { Value: ["chest"] },
  };
  const ordered = sortAxialStack([abdomen, chest]);
  assert.equal(ordered[0]["00080018"].Value[0], "chest");
  assert.equal(ordered[1]["00080018"].Value[0], "abdomen");
});
