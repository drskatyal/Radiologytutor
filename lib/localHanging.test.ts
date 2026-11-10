import { strict as assert } from "node:assert";
import { test } from "node:test";
import { flattenSeries, hangLocal, layoutById, layoutForGrid, samePane } from "./localHanging";

const studies = [{ series: ["ax", "cor", "sag"] }, { series: ["prior"] }];

test("every series of every study, in panel order", () => {
  assert.deepEqual(flattenSeries(studies), [
    { study: 0, series: 0 },
    { study: 0, series: 1 },
    { study: 0, series: 2 },
    { study: 1, series: 0 },
  ]);
  assert.deepEqual(flattenSeries([]), []);
});

test("a 2×2 keeps the main pane and fills the rest with series nobody shows, across studies", () => {
  const flat = flattenSeries(studies);
  const hung = hangLocal(layoutById("2x2"), flat, [{ study: 0, series: 1 }]);
  assert.equal(hung.length, 4);
  assert.deepEqual(hung[0], { study: 0, series: 1 }, "the main pane keeps what it shows");
  assert.equal(new Set(hung.map((p) => `${p.study}:${p.series}`)).size, 4, "no series twice while others are unshown");
  assert.ok(hung.some((p) => p.study === 1), "the prior study is hung too");
});

test("re-hanging keeps what the reader put in each pane", () => {
  const flat = flattenSeries(studies);
  const before = [{ study: 0, series: 0 }, { study: 1, series: 0 }];
  const after = hangLocal(layoutById("2x2"), flat, before);
  assert.ok(samePane(after[1], { study: 1, series: 0 }));
});

test("one series side by side shows it twice (lung and mediastinal windows)", () => {
  const hung = hangLocal(layoutById("1x2"), flattenSeries([{ series: ["only"] }]), [{ study: 0, series: 0 }]);
  assert.deepEqual(hung, [{ study: 0, series: 0 }, { study: 0, series: 0 }]);
});

test("a pane whose series vanished takes another one", () => {
  const flat = flattenSeries(studies);
  const hung = hangLocal(layoutById("1x2"), flat, [{ study: 0, series: 0 }, { study: 5, series: 9 }]);
  assert.ok(flat.some((f) => samePane(f, hung[1])));
});

test("voice layouts map to hanging layouts", () => {
  assert.equal(layoutForGrid(1, 1), "1x1");
  assert.equal(layoutForGrid(1, 2), "1x2");
  assert.equal(layoutForGrid(2, 1), "2x1");
  assert.equal(layoutForGrid(2, 2), "2x2");
  assert.equal(layoutForGrid(1, 3), "1x3");
  assert.equal(layoutForGrid(2, 3), "2x3");
  assert.equal(layoutForGrid(3, 3), "3x3");
  assert.equal(layoutForGrid(4, 4), "3x3", "larger grids fall back to the largest web layout");
  assert.equal(layoutForGrid(3, 2), "2x2", "no 3 × 2: the nearest smaller grid");
});
