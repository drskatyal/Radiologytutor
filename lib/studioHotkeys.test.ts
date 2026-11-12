import test from "node:test";
import assert from "node:assert/strict";
import { studioHotkey } from "./studioHotkeys";
const base = { key: "x", code: "KeyX", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false, target: null };
test("studio hotkeys preserve typing, repeats, IME and native undo; marker undo is explicit Alt+Z", () => {
  assert.equal(studioHotkey(base), "record");
  assert.equal(studioHotkey({ ...base, key: "z", code: "KeyZ" }), "undo-marker");
  for (const flag of ["ctrlKey", "metaKey", "shiftKey", "repeat", "isComposing"] as const) assert.equal(studioHotkey({ ...base, [flag]: true }), null);
  assert.equal(studioHotkey({ ...base, target: { closest: () => ({}) } as unknown as EventTarget }), null);
  assert.equal(studioHotkey({ ...base, altKey: false }), null);
});
