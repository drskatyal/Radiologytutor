import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRIMARY,
  initToolBindings,
  setLeftTool,
  resolveToolForButton,
} from "./toolBindings.ts";

// Mirror the viewer's tool group: insertion order + permanent (fixed) bindings.
const ORDER = [
  "WindowLevel",
  "Pan",
  "Zoom",
  "StackScroll",
  "Length",
  "Angle",
  "ArrowAnnotate",
  "RectangleROI",
  "EllipticalROI",
  "Probe",
];
const FIXED = {
  Pan: "Auxiliary" as const,
  Zoom: "Secondary" as const,
  StackScroll: "Wheel" as const,
};

function fresh() {
  const s = initToolBindings(ORDER, FIXED);
  return setLeftTool(s, "WindowLevel"); // viewer's default left tool
}

test("default left tool owns the Primary button", () => {
  const s = fresh();
  assert.equal(resolveToolForButton(s, PRIMARY), "WindowLevel");
});

test("selecting an annotation tool gives IT the left button (the bug)", () => {
  // This is the regression guard: with the old additive logic WindowLevel kept
  // its Primary binding and — sitting earlier in insertion order — kept winning,
  // so Length never fired and nothing drew.
  const s = setLeftTool(fresh(), "Length");
  assert.equal(resolveToolForButton(s, PRIMARY), "Length");
});

test("every primary tool can claim the left button when selected", () => {
  for (const name of ORDER) {
    const s = setLeftTool(fresh(), name);
    assert.equal(
      resolveToolForButton(s, PRIMARY),
      name,
      `${name} should own Primary after selection`
    );
  }
});

test("exactly one tool ever holds the Primary binding", () => {
  let s = fresh();
  for (const name of ["Length", "Pan", "ArrowAnnotate", "WindowLevel", "Probe"]) {
    s = setLeftTool(s, name);
    const holders = ORDER.filter((t) => s.bindings[t].has(PRIMARY));
    assert.deepEqual(holders, [name], `only ${name} should hold Primary`);
  }
});

test("manipulation tools keep their wheel/right/middle bindings throughout", () => {
  let s = fresh();
  // Switch the left tool around a lot, then assert the fixed bindings survived.
  for (const name of ["Length", "Pan", "Zoom", "StackScroll", "Angle", "WindowLevel"]) {
    s = setLeftTool(s, name);
  }
  assert.ok(s.bindings.StackScroll.has("Wheel"), "scroll keeps the wheel");
  assert.ok(s.bindings.Zoom.has("Secondary"), "zoom keeps right-drag");
  assert.ok(s.bindings.Pan.has("Auxiliary"), "pan keeps middle-drag");
  // And the wheel/right/middle buttons still resolve to those tools.
  assert.equal(resolveToolForButton(s, "Wheel"), "StackScroll");
  assert.equal(resolveToolForButton(s, "Secondary"), "Zoom");
  assert.equal(resolveToolForButton(s, "Auxiliary"), "Pan");
});

test("picking Pan as the left tool still leaves middle-drag panning intact", () => {
  const s = setLeftTool(fresh(), "Pan");
  // Pan now owns BOTH primary and its fixed auxiliary binding.
  assert.equal(resolveToolForButton(s, PRIMARY), "Pan");
  assert.equal(resolveToolForButton(s, "Auxiliary"), "Pan");
});

test("no tool holds Primary before a left tool is chosen", () => {
  const s = initToolBindings(ORDER, FIXED);
  assert.equal(resolveToolForButton(s, PRIMARY), null);
});
