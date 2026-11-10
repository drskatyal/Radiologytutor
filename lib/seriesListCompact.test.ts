import assert from "node:assert/strict";
import { test } from "node:test";
import { readSeriesListCompact, SERIES_LIST_COMPACT_STORAGE_KEY, writeSeriesListCompact, type KeyValueStore } from "@flowrad/viewer-core/seriesPanel";

const memory = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

test("compact series list: off by default, remembered per device", () => {
  const store = memory();
  assert.equal(readSeriesListCompact(store), false);
  writeSeriesListCompact(true, store);
  assert.equal(store.data.get(SERIES_LIST_COMPACT_STORAGE_KEY), "1");
  assert.equal(readSeriesListCompact(store), true);
  writeSeriesListCompact(false, store);
  assert.equal(readSeriesListCompact(store), false);
});

test("compact series list: storage that is missing or throws means thumbnails, and still toggles", () => {
  assert.equal(readSeriesListCompact(null), false);
  const throwing: KeyValueStore = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readSeriesListCompact(throwing), false);
  assert.doesNotThrow(() => writeSeriesListCompact(true, throwing));
});
