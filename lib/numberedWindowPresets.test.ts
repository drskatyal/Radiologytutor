import { strict as assert } from "node:assert";
import { test } from "node:test";
import { numberedWindowPresets, viewerWindowPresets, matchPreset } from "./windowPresets";

test("CT number keys: lung, bone, brain, abdomen first (the desktop order)", () => {
  const ct = numberedWindowPresets("CT").map((p) => p.label);
  assert.deepEqual(ct.slice(0, 4), ["Lung", "Bone", "Brain", "Abdomen"]);
  assert.ok(ct.includes("Soft tissue"));
  assert.equal(new Set(ct).size, ct.length, "no duplicates");
});

test("PET gets SUV windows; MR has no fixed windows of its own", () => {
  assert.deepEqual(numberedWindowPresets("pt").map((p) => p.id), ["pt-suv5", "pt-suv10", "pt-suv15"]);
  assert.deepEqual(numberedWindowPresets("MR"), []);
});

test("the web menu (and its keys) follow the numbered list, never empty", () => {
  assert.deepEqual(viewerWindowPresets("CT"), numberedWindowPresets("CT"));
  assert.ok(viewerWindowPresets("MR").length > 0);
  assert.ok(viewerWindowPresets(undefined).length > 0);
});

test("the active preset is recognised for the added CT and PET windows", () => {
  assert.equal(matchPreset(400, 60), "ct-abdomen");
  assert.equal(matchPreset(5, 2.5), "pt-suv5");
  assert.equal(matchPreset(1500, -600), "ct-lung");
});
