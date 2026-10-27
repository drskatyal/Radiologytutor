import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SERIES_RAIL_STORAGE_KEY,
  parseSeriesRailOpen,
  readSeriesRailOpen,
  seriesRailToggleLabel,
  writeSeriesRailOpen,
  type SeriesRailStorage,
} from "./seriesRailPreference.ts";

function memoryStorage(initial?: Record<string, string>): SeriesRailStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

test("an unset series rail stays open", () => {
  assert.equal(parseSeriesRailOpen(null), true);
  assert.equal(parseSeriesRailOpen(undefined), true);
  assert.equal(parseSeriesRailOpen(""), true);
  assert.equal(parseSeriesRailOpen("1"), true);
  assert.equal(parseSeriesRailOpen("nope"), true);
  assert.equal(readSeriesRailOpen(null), true);
  assert.equal(readSeriesRailOpen(memoryStorage()), true);
});

test("only the stored closed flag collapses the rail", () => {
  assert.equal(parseSeriesRailOpen("0"), false);
  const storage = memoryStorage({ [SERIES_RAIL_STORAGE_KEY]: "0" });
  assert.equal(readSeriesRailOpen(storage), false);
});

test("the rail preference round-trips through storage", () => {
  const storage = memoryStorage();
  writeSeriesRailOpen(storage, false);
  assert.equal(storage.map.get(SERIES_RAIL_STORAGE_KEY), "0");
  assert.equal(readSeriesRailOpen(storage), false);
  writeSeriesRailOpen(storage, true);
  assert.equal(storage.map.get(SERIES_RAIL_STORAGE_KEY), "1");
  assert.equal(readSeriesRailOpen(storage), true);
});

test("a storage that throws does not break the rail toggle", () => {
  const storage: SeriesRailStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(readSeriesRailOpen(storage), true);
  assert.doesNotThrow(() => writeSeriesRailOpen(storage, false));
  assert.doesNotThrow(() => writeSeriesRailOpen(undefined, false));
});

test("the expand label names the series currently in the viewport", () => {
  assert.equal(
    seriesRailToggleLabel({
      open: false,
      series: [
        { description: "Ax T2", seriesNumber: 2 },
        { description: "  DWI  ", seriesNumber: 5 },
      ],
      activeIndex: 1,
    }),
    "Expand series list, 2 series, showing DWI"
  );
  assert.equal(
    seriesRailToggleLabel({
      open: false,
      series: [{ description: "   ", seriesNumber: 4 }],
      activeIndex: 0,
    }),
    "Expand series list, 1 series, showing Series 4"
  );
  assert.equal(
    seriesRailToggleLabel({
      open: false,
      series: [{ description: "" }],
      activeIndex: 0,
    }),
    "Expand series list, 1 series, showing Series"
  );
});

test("collapse stays a short name and an empty rail still expands", () => {
  assert.equal(
    seriesRailToggleLabel({ open: true, series: [{ description: "Ax T2" }], activeIndex: 0 }),
    "Collapse series list"
  );
  assert.equal(
    seriesRailToggleLabel({ open: false, series: [], activeIndex: 0 }),
    "Expand series list"
  );
  assert.equal(
    seriesRailToggleLabel({
      open: false,
      series: [{ description: "Ax T2" }],
      activeIndex: 4,
    }),
    "Expand series list, 1 series"
  );
});
