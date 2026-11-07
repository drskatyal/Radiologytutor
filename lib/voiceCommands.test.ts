import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_PHRASE_WORDS, normalizeUtterance, parseVoiceCommand, voiceCommandSheet, voiceGrammar, VOICE_COMMANDS } from "../packages/viewer-core/src/voiceCommands.ts";

test("grammar: every phrase once, plus [unk]", () => {
  const g = voiceGrammar();
  assert.equal(g.at(-1), "[unk]");
  assert.equal(new Set(g).size, g.length, "no duplicate phrases");
  assert.ok(g.includes("next series") && g.includes("lung window") && g.includes("layout four"));
  assert.ok(!g.includes("lung") && !g.includes("bone") && !g.includes("zoom"), "no single words");
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
    ["zoom tool", { type: "tool", tool: "Zoom" }],
    ["pan tool", { type: "tool", tool: "Pan" }],
    ["window level", { type: "tool", tool: "WindowLevel" }],
    ["measure tool", { type: "tool", tool: "Length" }],
    ["ellipse tool", { type: "tool", tool: "EllipticalROI" }],
    ["angle tool", { type: "tool", tool: "Angle" }],
    ["arrow tool", { type: "tool", tool: "ArrowAnnotate" }],
    ["reset view", { type: "reset" }],
    ["invert image", { type: "invert" }],
    ["m p r", { type: "mpr" }],
    ["three d", { type: "volume3d" }],
    ["m i p", { type: "slab", mode: "mip" }],
    ["min i p", { type: "slab", mode: "minip" }],
    ["thicker slab", { type: "slabThickness", deltaMm: 5 }],
    ["thinner slab", { type: "slabThickness", deltaMm: -5 }],
    ["layout one", { type: "layout", rows: 1, cols: 1 }],
    ["layout two", { type: "layout", rows: 1, cols: 2 }],
    ["layout four", { type: "layout", rows: 2, cols: 2 }],
    ["layout three", { type: "layout", rows: 1, cols: 3 }],
    ["layout six", { type: "layout", rows: 2, cols: 3 }],
    ["layout nine", { type: "layout", rows: 3, cols: 3 }],
    ["lung window", { type: "preset", name: "lung" }],
    ["bone window", { type: "preset", name: "bone" }],
    ["brain window", { type: "preset", name: "brain" }],
    ["abdomen window", { type: "preset", name: "abdomen" }],
    ["stop listening", { type: "stop" }],
  ];
  for (const [said, action] of expect) assert.deepEqual(parseVoiceCommand(said), action, said);
});

test("every phrase is two or more words: no single-word commands", () => {
  for (const c of VOICE_COMMANDS) for (const p of c.phrases) assert.ok(p.split(" ").length >= MIN_PHRASE_WORDS, `“${p}” (${c.label}) is a full phrase`);
  for (const p of voiceGrammar().filter((p) => p !== "[unk]")) assert.ok(p.includes(" "), `grammar entry “${p}”`);
});

test("single words never match", () => {
  for (const word of ["bone", "lung", "brain", "abdomen", "zoom", "pan", "reset", "invert", "window", "measure", "next", "up", "down", "volume", "grid", "single", "thicker"]) {
    assert.equal(parseVoiceCommand(word), null, word);
  }
  // Every word of every phrase, said alone.
  for (const word of new Set(VOICE_COMMANDS.flatMap((c) => c.phrases.flatMap((p) => p.split(" "))))) {
    assert.equal(parseVoiceCommand(word), null, `“${word}” alone`);
  }
});

test("only the whole utterance matches: a phrase inside longer speech fires nothing", () => {
  assert.deepEqual(parseVoiceCommand("bone window"), { type: "preset", name: "bone" });
  assert.equal(parseVoiceCommand("the bone window looks fine"), null);
  assert.equal(parseVoiceCommand("um zoom in please"), null);
  assert.equal(parseVoiceCommand("lung window please"), null);
  assert.equal(parseVoiceCommand("[unk] next series [unk]"), null, "garbage around a phrase");
  assert.equal(parseVoiceCommand("[unk] lung window"), null);
  assert.equal(parseVoiceCommand("next series next series"), null);
});

test("case and surrounding whitespace are allowed; unknown is null", () => {
  assert.deepEqual(parseVoiceCommand("  Lung   Window "), { type: "preset", name: "lung" });
  assert.deepEqual(parseVoiceCommand("\tNEXT SERIES\n"), { type: "series", delta: 1 });
  assert.equal(parseVoiceCommand("[unk]"), null);
  assert.equal(parseVoiceCommand(""), null);
  assert.equal(parseVoiceCommand("hello there"), null);
  assert.equal(normalizeUtterance("  Next   SERIES "), "next series");
});

test("help sheet lists every command", () => {
  assert.equal(voiceCommandSheet().length, VOICE_COMMANDS.length);
});

test("the grouped list (web and desktop help) shows every command exactly once", async () => {
  const { voiceCommandRows, VOICE_GROUP_ORDER } = await import("../packages/viewer-core/src/voiceCommands.ts");
  const rows = voiceCommandRows();
  assert.equal(rows.length, VOICE_COMMANDS.length);
  assert.deepEqual(new Set(rows.map((r) => r.label)).size, VOICE_COMMANDS.length);
  for (const row of rows) {
    assert.ok(VOICE_GROUP_ORDER.includes(row.group), row.label);
    assert.ok(row.phrases.every((p) => p.split(" ").length >= MIN_PHRASE_WORDS), row.label);
  }
  // Grouped in the published order.
  const order = rows.map((r) => VOICE_GROUP_ORDER.indexOf(r.group));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});
