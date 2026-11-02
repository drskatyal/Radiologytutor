import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUtterance, parseVoiceCommand, voiceCommandSheet, voiceGrammar, VOICE_COMMANDS } from "../packages/viewer-core/src/voiceCommands.ts";

test("grammar: every phrase once, plus [unk]", () => {
  const g = voiceGrammar();
  assert.equal(g.at(-1), "[unk]");
  assert.equal(new Set(g).size, g.length, "no duplicate phrases");
  assert.ok(g.includes("next series") && g.includes("lung window") && g.includes("layout four"));
});

test("the requested commands all parse", () => {
  const expect: [string, unknown][] = [
    ["next series", { type: "series", delta: 1 }],
    ["previous series", { type: "series", delta: -1 }],
    ["scroll up", { type: "slice", delta: -1 }],
    ["scroll down", { type: "slice", delta: 1 }],
    ["next slice", { type: "slice", delta: 1 }],
    ["previous slice", { type: "slice", delta: -1 }],
    ["page up", { type: "page", dir: -1 }],
    ["page down", { type: "page", dir: 1 }],
    ["zoom in", { type: "zoom", factor: 1.25 }],
    ["zoom out", { type: "zoom", factor: 0.8 }],
    ["pan", { type: "tool", tool: "Pan" }],
    ["window level", { type: "tool", tool: "WindowLevel" }],
    ["measure", { type: "tool", tool: "Length" }],
    ["ellipse", { type: "tool", tool: "EllipticalROI" }],
    ["angle", { type: "tool", tool: "Angle" }],
    ["arrow", { type: "tool", tool: "ArrowAnnotate" }],
    ["reset", { type: "reset" }],
    ["invert", { type: "invert" }],
    ["m p r", { type: "mpr" }],
    ["three d", { type: "volume3d" }],
    ["m i p", { type: "slab", mode: "mip" }],
    ["min i p", { type: "slab", mode: "minip" }],
    ["thicker", { type: "slabThickness", deltaMm: 5 }],
    ["thinner", { type: "slabThickness", deltaMm: -5 }],
    ["layout one", { type: "layout", rows: 1, cols: 1 }],
    ["layout two", { type: "layout", rows: 1, cols: 2 }],
    ["layout four", { type: "layout", rows: 2, cols: 2 }],
    ["lung window", { type: "preset", name: "lung" }],
    ["bone window", { type: "preset", name: "bone" }],
    ["brain window", { type: "preset", name: "brain" }],
    ["abdomen window", { type: "preset", name: "abdomen" }],
  ];
  for (const [said, action] of expect) assert.deepEqual(parseVoiceCommand(said), action, said);
});

test("noise and fillers: longest phrase wins, unknown is null", () => {
  assert.deepEqual(parseVoiceCommand("[unk] next series [unk]"), { type: "series", delta: 1 });
  assert.deepEqual(parseVoiceCommand("um zoom in please"), { type: "zoom", factor: 1.25 }, "not the bare 'zoom' tool");
  assert.deepEqual(parseVoiceCommand("Lung Window!"), { type: "preset", name: "lung" });
  assert.equal(parseVoiceCommand("[unk]"), null);
  assert.equal(parseVoiceCommand(""), null);
  assert.equal(parseVoiceCommand("hello there"), null);
  assert.equal(normalizeUtterance("  Next   SERIES. "), "next series");
});

test("help sheet lists every command", () => {
  assert.equal(voiceCommandSheet().length, VOICE_COMMANDS.length);
});
