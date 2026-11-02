import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  IDENTITY_ORIENTATION,
  ORIENTATION_COMMANDS,
  applyOrientation,
  isOrientationCommand,
  normalizeRotation,
  orientMarkers,
  orientPoint,
  type OrientationCommand,
  type ViewOrientation,
} from "../packages/viewer-core/src/viewOrientation";
import { toCell, transformFor } from "../desktop/src/native/transform";

// Rotate / flip: screen-space flips and edge letters that follow the image.

const ALL: ViewOrientation[] = [0, 90, 180, 270].flatMap((rotation) =>
  [false, true].flatMap((flipH) => [false, true].map((flipV) => ({ rotation, flipH, flipV })))
);
const PTS: [number, number][] = [[3, 1], [-2, 5], [0, -4]];

test("the command list is the six the toolbar, menu and keys share", () => {
  assert.deepEqual(
    ORIENTATION_COMMANDS.map((c) => c.command),
    ["rotate:90", "rotate:-90", "rotate:180", "flip:h", "flip:v", "orient:reset"]
  );
  assert.deepEqual(ORIENTATION_COMMANDS.map((c) => c.shortcut).filter(Boolean), ["R", "Shift+R", "H", "V"]);
  assert.ok(isOrientationCommand("flip:v"));
  assert.ok(!isOrientationCommand("zoom:fit"));
});

test("rotation normalises to 0 / 90 / 180 / 270", () => {
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation(-360), 0);
});

test("rotate 90° clockwise turns screen-right to screen-bottom (y down)", () => {
  const o = applyOrientation(IDENTITY_ORIENTATION, "rotate:90");
  assert.deepEqual(orientPoint(o, 1, 0).map(Math.round), [0, 1]);
  const back = applyOrientation(o, "rotate:-90");
  assert.deepEqual(back, IDENTITY_ORIENTATION);
  assert.equal(applyOrientation(applyOrientation(IDENTITY_ORIENTATION, "rotate:180"), "rotate:180").rotation, 0);
});

test("flips mirror the SCREEN whatever the rotation", () => {
  for (const o of ALL) {
    const h = applyOrientation(o, "flip:h");
    const v = applyOrientation(o, "flip:v");
    for (const [x, y] of PTS) {
      const [px, py] = orientPoint(o, x, y);
      assert.deepEqual(orientPoint(h, x, y), [-px + 0, py + 0], `flip:h from ${JSON.stringify(o)}`);
      assert.deepEqual(orientPoint(v, x, y), [px + 0, -py + 0], `flip:v from ${JSON.stringify(o)}`);
    }
    assert.deepEqual(applyOrientation(o, "orient:reset"), IDENTITY_ORIENTATION);
  }
});

test("orientPoint is the native renderer's transform (native_view.rs / transform.ts)", () => {
  for (const o of ALL) {
    const t = transformFor({ index: 0, wl: [40, 400], zoom: 1, pan: [0, 0], invert: false, ...o }, 100, 100, 100, 100);
    for (const [x, y] of PTS) {
      const [cx, cy] = toCell(t, 50 + x, 50 + y);
      const [sx, sy] = orientPoint(o, x, y);
      assert.ok(Math.abs(cx - 50 - sx) < 1e-9 && Math.abs(cy - 50 - sy) < 1e-9, JSON.stringify(o));
    }
  }
});

test("edge letters follow the image: an axial rotated and flipped", () => {
  // Axial, unrotated: patient Right on screen-left, Anterior at the top.
  const axial = { top: "A", bottom: "P", left: "R", right: "L" };
  assert.deepEqual(orientMarkers(axial, IDENTITY_ORIENTATION), axial);
  const cw = applyOrientation(IDENTITY_ORIENTATION, "rotate:90");
  assert.deepEqual(orientMarkers(axial, cw), { top: "R", bottom: "L", left: "P", right: "A" });
  const mirrored = applyOrientation(IDENTITY_ORIENTATION, "flip:h");
  assert.deepEqual(orientMarkers(axial, mirrored), { top: "A", bottom: "P", left: "L", right: "R" });
  // Any sequence: the letters are always a permutation of the four, opposite pairs kept.
  let o = IDENTITY_ORIENTATION;
  const seq: OrientationCommand[] = ["rotate:90", "flip:v", "rotate:180", "flip:h", "rotate:-90"];
  for (const c of seq) {
    o = applyOrientation(o, c);
    const m = orientMarkers(axial, o);
    const opposite: Record<string, string> = { A: "P", P: "A", R: "L", L: "R" };
    assert.equal(opposite[m.top], m.bottom);
    assert.equal(opposite[m.left], m.right);
  }
});

import {
  SERIES_PANEL_STORAGE_KEY,
  isSeriesPanelShortcut,
  readSeriesPanelCollapsed,
  writeSeriesPanelCollapsed,
} from "../packages/viewer-core/src/seriesPanel";

test("series panel: remembered per device, Ctrl+B / Cmd+B, storage failures harmless", () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.equal(readSeriesPanelCollapsed(store), false);
  writeSeriesPanelCollapsed(true, store);
  assert.equal(mem.get(SERIES_PANEL_STORAGE_KEY), "1");
  assert.equal(readSeriesPanelCollapsed(store), true);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readSeriesPanelCollapsed(broken), false);
  assert.doesNotThrow(() => writeSeriesPanelCollapsed(true, broken));
  assert.ok(isSeriesPanelShortcut({ key: "b", ctrlKey: true }));
  assert.ok(!isSeriesPanelShortcut({ key: "b", ctrlKey: true, shiftKey: true }));
  assert.ok(isSeriesPanelShortcut({ key: "b", metaKey: true }, true));
  assert.ok(!isSeriesPanelShortcut({ key: "b", ctrlKey: true }, true));
});
