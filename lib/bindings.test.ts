import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BindingError,
  BindingsFileError,
  GestureTracker,
  InputCapture,
  MOUSE_COMMANDS,
  RADIANT_PRESET,
  acceptsInput,
  assignInput,
  boundButtons,
  clearInput,
  commandFor,
  dragRules,
  dragToolFor,
  effectiveInputs,
  exportBindings,
  findConflict,
  inputIndex,
  inputKind,
  inputLabel,
  isValidSpec,
  keyMatches,
  keySpecOf,
  loadStoredBindings,
  migrateShortcutOverrides,
  mouseSpecOf,
  newerBindings,
  normalizeSpec,
  parseBindings,
  resetCommand,
  saveStoredBindings,
  tiltSpecOf,
  wheelActionFor,
  wheelRules,
  withMouseCommands,
  engineModifierName,
  isNotchedHorizontal,
  keyLabel,
  nativeMouseWanted,
  type BindingCommand,
} from "../packages/viewer-core/src/bindings/index.ts";

test("macOS: Mod is ⌘ (Meta) for keys, mouse and the engine; Ctrl elsewhere", () => {
  // The same stored default (Mod+…) fires from ⌘ on a Mac and Ctrl on Windows.
  assert.equal(keySpecOf({ key: "z", code: "KeyZ", metaKey: true }, true), "Mod+Z");
  assert.equal(keySpecOf({ key: "z", code: "KeyZ", ctrlKey: true }, false), "Mod+Z");
  assert.equal(keySpecOf({ key: "z", code: "KeyZ", ctrlKey: true }, true), "Ctrl+Z", "the Mac's Control key is its own modifier");
  assert.equal(keyMatches("Mod+Z", { key: "z", code: "KeyZ", metaKey: true }, true), true);
  assert.equal(keyMatches("Mod+Z", { key: "z", code: "KeyZ", ctrlKey: true }, true), false);
  assert.equal(mouseSpecOf(2, "drag", { metaKey: true }, true), "Mod+Mouse2Drag");
  assert.equal(mouseSpecOf(2, "drag", { ctrlKey: true }, false), "Mod+Mouse2Drag");
  // Engine (Cornerstone) modifier for a rule: Meta on a Mac.
  assert.equal(engineModifierName({ mod: true }, true), "Meta");
  assert.equal(engineModifierName({ mod: true }, false), "Ctrl");
  assert.equal(engineModifierName({ mod: true, shift: true }, true), "ShiftMeta");
  assert.equal(engineModifierName({ mod: true, alt: true }, true), "AltMeta");
  assert.equal(engineModifierName({ mod: true, alt: true }, false), "CtrlAlt");
  assert.equal(engineModifierName({}, true), "");
  // ⌘+right drag zooms on a Mac (preset Mod+Mouse2Drag).
  const rules = dragRules(MOUSE_COMMANDS);
  assert.equal(dragToolFor(rules, 2, { metaKey: true }, true), "Zoom");
  assert.equal(wheelActionFor(wheelRules(MOUSE_COMMANDS), { metaKey: true }, true), "slab");
  // Labels use the Mac glyphs.
  assert.equal(keyLabel("Mod+Shift+R", true), "⌘⇧R");
  assert.equal(keyLabel("Mod+Shift+R", false), "Ctrl+Shift+R");
});

test("macOS: a trackpad swipe is not a tilt notch; a notched wheel / native tilt is", () => {
  // Trackpad: precise pixel deltas, wheelDeltaX = -3 × deltaX.
  assert.equal(tiltSpecOf({ deltaX: 12.5, deltaY: 0, deltaMode: 0, wheelDeltaX: -37.5 }, true), null);
  assert.equal(tiltSpecOf({ deltaX: 40, deltaY: 0, deltaMode: 0, wheelDeltaX: -120 }, true), null, "-3×deltaX even at 120 is a trackpad");
  assert.equal(tiltSpecOf({ deltaX: 40, deltaY: 0, deltaMode: 0 }, true), null, "no legacy delta: not provably a notch");
  // The desktop shell's native tilt (line mode) and a notched wheel's ±120.
  assert.equal(tiltSpecOf({ deltaX: -3, deltaY: 0, deltaMode: 1 }, true), "WheelLeft");
  assert.equal(tiltSpecOf({ deltaX: 4, deltaY: 0, deltaMode: 0, wheelDeltaX: -120 }, true), "WheelRight");
  assert.equal(isNotchedHorizontal({ deltaX: 4, deltaY: 0, wheelDeltaX: 240 }), true);
  // Windows / Linux unchanged: any horizontal step is tilt.
  assert.equal(tiltSpecOf({ deltaX: 40, deltaY: 0, deltaMode: 0 }, false), "WheelRight");
});

test("native mouse: forward side buttons / tilt only when a binding uses them", () => {
  assert.deepEqual(nativeMouseWanted(["R", "Mod+Mouse2Drag", "Mouse1Drag"]), { buttons: false, tilt: false });
  assert.deepEqual(nativeMouseWanted(["Mouse3"]), { buttons: true, tilt: false });
  assert.deepEqual(nativeMouseWanted(["Shift+Mouse6Drag"]), { buttons: true, tilt: false });
  assert.deepEqual(nativeMouseWanted(["Alt+WheelRight"]), { buttons: false, tilt: true });
  // The RadiAnt preset binds back / forward to the previous / next series.
  const preset = [...inputIndex(withMouseCommands(ACTIONS)).keys()];
  assert.equal(nativeMouseWanted(preset).buttons, true);
});

const ACTIONS: BindingCommand[] = [
  { id: "rotate.cw", label: "Rotate 90° clockwise", group: "View", kind: "action", defaults: ["R"] },
  { id: "rotate.ccw", label: "Rotate 90° anticlockwise", group: "View", kind: "action", defaults: ["Shift+R"] },
  { id: "flip.h", label: "Flip horizontal", group: "View", kind: "action", defaults: ["H"] },
  { id: "tool.rect", label: "Rectangle ROI", group: "Tools", kind: "action", defaults: ["S"] },
  { id: "series.prev", label: "Previous series", group: "Navigate", kind: "action", defaults: ["ArrowLeft"] },
  { id: "series.next", label: "Next series", group: "Navigate", kind: "action", defaults: ["ArrowRight"] },
  { id: "cine", label: "Play / pause cine", group: "Navigate", kind: "action", defaults: [] },
];
const TABLE = withMouseCommands(ACTIONS);

test("specs: canonical modifier order, any button, F13–F24, tilt", () => {
  assert.equal(normalizeSpec("Shift+Mod+r"), "Mod+Shift+R");
  assert.equal(keySpecOf({ key: "F13", code: "F13" }, false), "F13");
  assert.equal(keySpecOf({ key: "k", code: "KeyK", ctrlKey: true, altKey: true }, false), "Mod+Alt+K");
  assert.equal(keySpecOf({ key: "Unidentified", code: "F20" }, false), "F20", "mouse software that sends no key name still binds");
  assert.equal(keySpecOf({ key: "Control", code: "ControlLeft", ctrlKey: true }, false), null);
  assert.equal(mouseSpecOf(5, "click"), "Mouse5");
  assert.equal(mouseSpecOf(2, "drag", { ctrlKey: true }, false), "Mod+Mouse2Drag");
  assert.equal(tiltSpecOf({ deltaX: -40, deltaY: 0 }, false), "WheelLeft");
  assert.equal(tiltSpecOf({ deltaX: 0, deltaY: 100 }, false), null);
  assert.equal(tiltSpecOf({ deltaX: 100, deltaY: 0, shiftKey: true }, false), null, "Shift+wheel stays the vertical wheel");
  assert.equal(inputKind("Mouse12"), "click");
  assert.equal(inputKind("Mod+Mouse2Drag"), "drag");
  assert.equal(inputKind("Mod+Wheel"), "wheel");
  assert.equal(inputKind("WheelRight"), "tilt");
  assert.equal(inputKind("F13"), "key");
  assert.ok(isValidSpec("Mod+Alt+F24"));
  assert.ok(!isValidSpec("Hyper+R"));
  assert.ok(!isValidSpec(""));
  assert.ok(keyMatches("Mod+Shift+R", { key: "R", code: "KeyR", ctrlKey: true, shiftKey: true }, false));
  assert.ok(!keyMatches("R", { key: "r", code: "KeyR", ctrlKey: true }, false));
});

test("labels name what the reader pressed", () => {
  assert.equal(inputLabel("Mouse5", false), "Mouse button 6");
  assert.equal(inputLabel("Mouse3", false), "Mouse 4 (back)");
  assert.equal(inputLabel("Mouse2Drag", false), "Right drag");
  assert.equal(inputLabel("Mod+Mouse2Drag", false), "Ctrl+Right drag");
  assert.equal(inputLabel("Mod+Mouse2Drag", true), "⌘Right drag");
  assert.equal(inputLabel("Mouse1", false), "Middle click");
  assert.equal(inputLabel("WheelLeft", false), "Wheel tilt left");
  assert.equal(inputLabel("Mod+Wheel", false), "Ctrl+Wheel");
  assert.equal(inputLabel("F13", false), "F13");
  assert.equal(inputLabel("ArrowLeft", false), "←");
});

test("preset: RadiAnt mouse rows", () => {
  assert.deepEqual(RADIANT_PRESET["drag.windowLevel"], ["Mouse2Drag"]);
  assert.deepEqual(RADIANT_PRESET["drag.pan"], ["Mouse1Drag"]);
  assert.deepEqual(RADIANT_PRESET["drag.zoom"], ["Mod+Mouse2Drag"]);
  assert.deepEqual(RADIANT_PRESET["wheel.scroll"], ["Wheel"]);
  assert.deepEqual(RADIANT_PRESET["series.prev"], ["Mouse3"]);
  assert.deepEqual(RADIANT_PRESET["series.next"], ["Mouse4"]);
  const eff = effectiveInputs(TABLE);
  assert.deepEqual(eff.get("series.prev"), ["ArrowLeft", "Mouse3"], "mouse defaults merge into the surface's commands");
  const index = inputIndex(TABLE);
  assert.equal(commandFor(index, "Mouse4"), "series.next");
  assert.equal(commandFor(index, "r"), "rotate.cw");
  assert.ok(MOUSE_COMMANDS.every((c) => c.group === "Mouse"));
});

test("overrides layer by command id; claimed inputs leave their default", () => {
  const o = { "flip.h": ["R"] };
  const eff = effectiveInputs(TABLE, o);
  assert.deepEqual(eff.get("flip.h"), ["R"]);
  assert.deepEqual(eff.get("rotate.cw"), [], "R moved to flip, so rotate loses it");
  assert.deepEqual(eff.get("rotate.ccw"), ["Shift+R"], "untouched rows keep the preset");
  assert.equal(commandFor(inputIndex(TABLE, o), "H"), undefined, "flip no longer answers to H");
});

test("conflicts: refuse, swap, add, clear, reset", () => {
  assert.equal(findConflict(TABLE, {}, "tool.rect", "R")?.label, "Rotate 90° clockwise");
  assert.equal(findConflict(TABLE, {}, "rotate.cw", "R"), null, "its own input is not a conflict");
  assert.throws(() => assignInput(TABLE, {}, "tool.rect", "R"), (e: unknown) => e instanceof BindingError && /already “Rotate 90° clockwise”/.test(e.message));

  const swapped = assignInput(TABLE, {}, "tool.rect", "R", { swap: true });
  assert.deepEqual(swapped["tool.rect"], ["R"]);
  assert.deepEqual(swapped["rotate.cw"], ["S"], "swap hands the old key to the other command");
  const idx = inputIndex(TABLE, swapped);
  assert.equal(commandFor(idx, "S"), "rotate.cw");
  assert.equal(commandFor(idx, "R"), "tool.rect");

  const added = assignInput(TABLE, {}, "cine", "F13", { mode: "add" });
  assert.deepEqual(added.cine, ["F13"]);
  const two = assignInput(TABLE, added, "cine", "Mouse5", { mode: "add" });
  assert.deepEqual(two.cine, ["F13", "Mouse5"]);
  assert.deepEqual(clearInput(TABLE, two, "cine", "F13").cine, ["Mouse5"]);
  assert.deepEqual(clearInput(TABLE, {}, "flip.h")["flip.h"], [], "a cleared row stays unbound");

  assert.deepEqual(resetCommand(TABLE, swapped, "tool.rect"), { "rotate.cw": ["S"] });
  assert.deepEqual(resetCommand(TABLE, { "flip.h": ["V"] }, "flip.h"), {});
  // Binding a row back to exactly its preset drops the override.
  assert.deepEqual(assignInput(TABLE, { "flip.h": ["V"] }, "flip.h", "H"), {});
});

test("kinds: drags, wheels and actions take only their own inputs", () => {
  assert.ok(acceptsInput("action", "Mouse5"));
  assert.ok(acceptsInput("action", "WheelLeft"));
  assert.ok(acceptsInput("action", "F13"));
  assert.ok(!acceptsInput("action", "Mouse2Drag"));
  assert.ok(acceptsInput("drag", "Mouse5Drag"));
  assert.ok(!acceptsInput("drag", "Mouse0Drag"), "left button stays the selected tool");
  assert.ok(!acceptsInput("action", "Mouse2"), "right click stays the image menu");
  assert.ok(!acceptsInput("action", "Mouse0"));
  assert.ok(acceptsInput("wheel", "Alt+Wheel"));
  assert.ok(!acceptsInput("wheel", "R"));
  assert.throws(() => assignInput(TABLE, {}, "drag.zoom", "F13"), BindingError);
});

test("mouse: right drag W/L by default, rebind to zoom, extra buttons", () => {
  let rules = dragRules(TABLE);
  assert.equal(dragToolFor(rules, 2), "WindowLevel");
  assert.equal(dragToolFor(rules, 2, { ctrlKey: true }), "Zoom");
  assert.equal(dragToolFor(rules, 1), "Pan");
  assert.equal(dragToolFor(rules, 1, { shiftKey: true }), "Pan", "an unbound modifier falls back to the plain gesture");
  assert.equal(dragToolFor(rules, 0), undefined);

  const o = assignInput(TABLE, {}, "drag.zoom", "Mouse2Drag", { swap: true });
  rules = dragRules(TABLE, o);
  assert.equal(dragToolFor(rules, 2), "Zoom", "right drag rebound to zoom");
  assert.equal(dragToolFor(rules, 2, { ctrlKey: true }), "WindowLevel", "W/L took zoom's old Ctrl+right drag");

  const extra = assignInput(TABLE, {}, "drag.scroll", "Mouse5Drag");
  assert.equal(dragToolFor(dragRules(TABLE, extra), 5), "StackScroll");
  assert.deepEqual([...boundButtons(TABLE, extra)].sort(), [1, 2, 3, 4, 5]);

  const w = wheelRules(TABLE);
  assert.equal(wheelActionFor(w, {}), "scroll");
  assert.equal(wheelActionFor(w, { ctrlKey: true }), "slab");
  assert.equal(wheelActionFor(w, { metaKey: true }, true), "slab", "⌘ is Mod on a Mac");
  const zoomWheel = assignInput(TABLE, {}, "wheel.zoom", "Shift+Wheel");
  assert.equal(wheelActionFor(wheelRules(TABLE, zoomWheel), { shiftKey: true }), "zoom");
});

test("click vs drag: 4 px threshold, any button", () => {
  const t = new GestureTracker();
  t.down({ button: 5, clientX: 10, clientY: 10 });
  assert.deepEqual(t.move({ clientX: 12, clientY: 11 }), []);
  assert.equal(t.up({ button: 5, clientX: 12, clientY: 11 })?.gesture, "click");
  t.down({ button: 2, clientX: 0, clientY: 0, ctrlKey: true });
  assert.equal(t.move({ clientX: 5, clientY: 0 }).length, 1);
  const up = t.up({ button: 2, clientX: 5, clientY: 0 });
  assert.equal(up?.gesture, "drag");
  assert.equal(up?.mods.ctrlKey, true);
});

test("capture: whatever the OS sends", () => {
  const c = new InputCapture(false);
  assert.equal(c.feed({ type: "keydown", key: "F13", code: "F13" }), "F13");
  assert.equal(c.feed({ type: "keydown", key: "k", code: "KeyK", ctrlKey: true, altKey: true }), "Mod+Alt+K");
  assert.equal(c.feed({ type: "pointerdown", button: 5, clientX: 0, clientY: 0 }), null);
  assert.equal(c.feed({ type: "pointerup", button: 5, clientX: 1, clientY: 0 }), "Mouse5");
  assert.equal(c.feed({ type: "auxclick", button: 7, clientX: 0, clientY: 0 }), "Mouse7", "a button seen only as auxclick still binds");
  c.feed({ type: "pointerdown", button: 2, clientX: 0, clientY: 0 });
  c.feed({ type: "pointermove", clientX: 20, clientY: 0 });
  assert.equal(c.feed({ type: "pointerup", button: 2, clientX: 20, clientY: 0 }), "Mouse2Drag");
  assert.equal(c.feed({ type: "wheel", deltaX: 30, deltaY: 0 }), "WheelRight");
  assert.equal(c.feed({ type: "wheel", deltaX: 0, deltaY: 100, ctrlKey: true }), "Mod+Wheel");
});

test("JSON: export / import round trip, validation, unknown ids dropped", () => {
  const o = assignInput(TABLE, assignInput(TABLE, {}, "cine", "F13"), "series.next", "Mouse5");
  const text = exportBindings(o, "web");
  const back = parseBindings(text, TABLE);
  assert.deepEqual(back.overrides, o);
  assert.deepEqual(back.dropped, []);
  assert.equal(back.surface, "web");

  const foreign = parseBindings(
    {
      format: "flowrad-bindings",
      version: 1,
      overrides: { "not.a.command": ["F1"], cine: ["F14", "Mouse2Drag", "Bogus+X"], "flip.h": ["F14"] },
    },
    TABLE
  );
  assert.deepEqual(foreign.overrides.cine, ["F14"]);
  assert.deepEqual(foreign.overrides["flip.h"], []);
  assert.deepEqual(foreign.dropped, ["not.a.command", "cine: Mouse2Drag", "cine: Bogus+X", "flip.h: F14 (bound twice)"]);
  assert.throws(() => parseBindings("{nope", TABLE), BindingsFileError);
  assert.throws(() => parseBindings({ format: "other" }, TABLE), BindingsFileError);
  assert.throws(() => parseBindings({ format: "flowrad-bindings", version: 99, overrides: {} }, TABLE), /newer/);
});

test("storage: web localStorage never throws; newest copy wins", () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.equal(loadStoredBindings(storage, TABLE), null);
  assert.ok(saveStoredBindings(storage, { cine: ["F13"] }, "web", undefined, "2026-01-01T00:00:00.000Z"));
  assert.deepEqual(loadStoredBindings(storage, TABLE)?.overrides, { cine: ["F13"] });
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(loadStoredBindings(broken, TABLE), null);
  assert.equal(saveStoredBindings(broken, {}, "web"), false);
  const a = { overrides: { cine: ["F13"] }, dropped: [], updatedAt: "2026-01-01T00:00:00.000Z" };
  const b = { overrides: { cine: ["F14"] }, dropped: [], updatedAt: "2026-02-01T00:00:00.000Z" };
  assert.equal(newerBindings(a, b), b);
  assert.equal(newerBindings(b, a), b);
  assert.equal(newerBindings(null, a), a);
});

test("migration: desktop ≤ 0.8.1 settings.shortcuts", () => {
  assert.deepEqual(migrateShortcutOverrides({ "rotate.cw": "Mod+Shift+K", "gone.id": "F2", "flip.h": 42 }, TABLE), {
    "rotate.cw": ["Mod+Shift+K"],
  });
  assert.deepEqual(migrateShortcutOverrides(undefined, TABLE), {});
});
