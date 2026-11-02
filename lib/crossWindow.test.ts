import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWindowSyncMessage,
  monitorColor,
  monitorTiles,
  tileAt,
  monitorLabel,
  nextMonitor,
  placeArrangement,
  referenceSegment,
  type MonitorInfo,
  type WindowArrangement,
  type XVec3,
} from "../packages/viewer-core/src/crossWindow.ts";

// A coronal image (plane y = 0) spanning x −100…100, z −150…150.
const coronal: [XVec3, XVec3, XVec3, XVec3] = [
  [-100, 0, 150],
  [100, 0, 150],
  [100, 0, -150],
  [-100, 0, -150],
];

test("reference line: an axial plane cuts the coronal image along x at its z", () => {
  const seg = referenceSegment({ origin: [0, 0, 40], normal: [0, 0, 1] }, coronal);
  assert.ok(seg);
  const [a, b] = seg!;
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;
  assert.ok(near(a[2], 40) && near(b[2], 40), `${a[2]}, ${b[2]}`);
  assert.ok(near(Math.min(a[0], b[0]), -100) && near(Math.max(a[0], b[0]), 100), "clipped to the remote image");
});

test("reference line: none for parallel planes or a plane outside the image", () => {
  assert.equal(referenceSegment({ origin: [0, 10, 0], normal: [0, 1, 0] }, coronal), null, "coronal on coronal");
  assert.equal(referenceSegment({ origin: [0, 0, 400], normal: [0, 0, 1] }, coronal), null, "axial above the image");
});

const mon = (name: string, x: number, width = 1920, scale = 1): MonitorInfo => ({ name, x, y: 0, width, height: 1080, scale });

test("placement: same monitor by name, else by position, never on one screen", () => {
  const saved: WindowArrangement = { monitor: mon("\\\\.\\DISPLAY2", 1920), rows: 1, cols: 2, cells: ["a", "b"] };
  const today = [mon("\\\\.\\DISPLAY1", 0), mon("\\\\.\\DISPLAY3", 1920, 2560, 1.5), mon("\\\\.\\DISPLAY2", 4480)];
  assert.equal(placeArrangement(saved, 0, today, "\\\\.\\DISPLAY1")?.name, "\\\\.\\DISPLAY2", "found by name though it moved");
  const renamed = [mon("\\\\.\\DISPLAY1", 0), mon("\\\\.\\DISPLAY9", 1920)];
  assert.equal(placeArrangement(saved, 0, renamed, "\\\\.\\DISPLAY1")?.name, "\\\\.\\DISPLAY9", "first other monitor");
  assert.equal(placeArrangement(saved, 0, [mon("\\\\.\\DISPLAY1", 0)], "\\\\.\\DISPLAY1"), null, "one monitor: do not reopen over the main window");
});

test("next monitor wraps; labels carry resolution and scaling", () => {
  const ms = [mon("A", 0), mon("B", 1920, 2560, 1.5)];
  assert.equal(nextMonitor(ms, "A")?.name, "B");
  assert.equal(nextMonitor(ms, "B")?.name, "A");
  assert.equal(nextMonitor([ms[0]], "A"), null);
  assert.equal(monitorLabel(ms, ms[1]), "Monitor 2 · 2560×1080 @150%");
});

test("messages: only well-formed sync messages are accepted", () => {
  assert.ok(isWindowSyncMessage({ kind: "voi", from: "viewer-1", ww: 400, wc: 40 }));
  assert.ok(!isWindowSyncMessage({ kind: "evil", from: "x" }));
  assert.ok(!isWindowSyncMessage({ kind: "voi" }));
  assert.ok(!isWindowSyncMessage(null));
});

test("picker tiles follow the desk: left/right, above, mixed sizes", () => {
  // 1: 1920×1080 at 0,0 · 2: 2560×1440 to its right · 3: 1920×1080 above monitor 1.
  const desk = [
    { name: "A", x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    { name: "B", x: 1920, y: -180, width: 2560, height: 1440, scale: 1.5 },
    { name: "C", x: 0, y: -1080, width: 1920, height: 1080, scale: 1 },
  ];
  const tiles = monitorTiles(desk, { width: 200, height: 120 }, 0);
  const [a, b, c] = tiles;
  assert.ok(b.left > a.left + a.width - 1e-6, "2 is right of 1");
  assert.ok(c.top + c.height <= a.top + 1e-6, "3 is above 1");
  assert.ok(Math.abs(b.width / a.width - 2560 / 1920) < 1e-9, "relative sizes kept");
  assert.ok(tiles.every((t) => t.left >= -1e-6 && t.top >= -1e-6 && t.left + t.width <= 200 + 1e-6 && t.top + t.height <= 120 + 1e-6), "inside the box");
  assert.deepEqual(tiles.map((t) => t.number), [1, 2, 3]);
  assert.equal(tiles[0].color, monitorColor(0));
  assert.notEqual(monitorColor(0), monitorColor(1));
  assert.equal(tileAt(tiles, b.left + 1, b.top + 1)?.name, "B");
  assert.equal(tileAt(tiles, -50, -50), null);
});
