import { test } from "node:test";
import assert from "node:assert/strict";
import { EDGE_COVER_MAX, EDGE_FADE_PX, EDGE_SOLID_PX, edgeSnap } from "./toolbarEdge";

// Spans are distances from the cut edge: `from` the near side, `to` the far side.
const button = (from: number, width = 44) => ({ from, to: from + width });

test("nothing under the chevron: the plain fade (0)", () => {
  // Controls that start beyond the chevron's black and fade.
  assert.equal(edgeSnap([button(EDGE_SOLID_PX + EDGE_FADE_PX + 2)]), 0);
  assert.equal(edgeSnap([]), 0);
});

test("a control half under the chevron: the black grows to the gap before it", () => {
  // A 44 px button from 6 px to 50 px off the edge (the 390 px phone case).
  assert.equal(edgeSnap([button(6)]), 51);
  // Already fully under the chevron's black: nothing to snap past.
  assert.equal(edgeSnap([{ from: 0, to: 30 }]), 0);
});

test("snapping past one control can reach the next: it keeps going, to whole controls", () => {
  // Buttons 2 px apart: covering the first (to 50) cuts the second (52..96)? no — 51 < 52.
  assert.equal(edgeSnap([button(6), button(52)]), 51);
  // A tight row where the first cover lands inside the next control.
  assert.equal(edgeSnap([button(20, 30), button(49, 40)]), 90);
});

test("a control only under the fade (a white selected tool showing through it) snaps too", () => {
  // 44 px button 40..84 px off the edge: clear of the 36 px black, inside the 20 px fade.
  assert.equal(edgeSnap([button(40)]), 85);
});

test("a group wider than the cap is left to the fade (its ends stay readable)", () => {
  assert.equal(edgeSnap([{ from: 10, to: EDGE_COVER_MAX + 50 }]), 0);
});
