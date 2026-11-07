import assert from "node:assert/strict";
import { test } from "node:test";

import {
  knownInstanceCount,
  lastTeacherSlice,
  mergeSeriesRail,
  neighborIndexes,
  resolveOpenIndex,
  seriesHintFromCase,
  wadorsImageId,
} from "./viewerLoad.ts";
import type { CaseSeries } from "./viewerSource.ts";

test("known instance counts drop missing and zero", () => {
  assert.equal(knownInstanceCount(undefined), undefined);
  assert.equal(knownInstanceCount(0), undefined);
  assert.equal(knownInstanceCount(-3), undefined);
  assert.equal(knownInstanceCount(1000), 1000);
});

test("wadors image ids stay unencoded in metadata order", () => {
  assert.equal(
    wadorsImageId("/api/dicomweb", "1.2.3", "1.2.4", "1.2.5"),
    "wadors:/api/dicomweb/studies/1.2.3/series/1.2.4/instances/1.2.5/frames/1"
  );
});

test("last teacher slice is the highest-order landing on that series", () => {
  const slice = lastTeacherSlice(
    [
      { order: 1, seriesInstanceUID: "s1", sliceIndex: 34 },
      { order: 3, seriesInstanceUID: "s1", sliceIndex: 64, sopInstanceUID: "sop.64" },
      { order: 2, seriesInstanceUID: "s2", sliceIndex: 10 },
    ],
    "s1"
  );
  assert.deepEqual(slice, { sliceIndex: 64, sopInstanceUID: "sop.64" });
  assert.equal(lastTeacherSlice([], "s1"), undefined);
});

test("open index prefers SOP, then stored slice, then the middle", () => {
  const sops = ["a", "b", "c", "d", "e"];
  assert.equal(resolveOpenIndex(5, sops, { sopInstanceUID: "d", sliceIndex: 1 }), 3);
  assert.equal(resolveOpenIndex(5, sops, { sliceIndex: 1 }), 1);
  assert.equal(resolveOpenIndex(1000, sops, null), 500);
});

test("neighbor prefetch is a window, not the series", () => {
  const around = neighborIndexes(1000, 500, 8);
  assert.equal(around.length, 16);
  assert.equal(around[0], 492);
  assert.equal(around[around.length - 1], 508);
  assert.equal(around.includes(500), false);
  assert.equal(around.includes(34), false);
});

test("series hints carry no invented counts and skip series without a study", () => {
  const hints = seriesHintFromCase(
    {
      modality: "CT",
      findings: [
        { order: 2, seriesInstanceUID: "series.b", studyInstanceUID: "study.1" },
        { order: 1, seriesInstanceUID: "series.a", studyInstanceUID: "study.1" },
      ],
      studyRefs: [
        { order: 0, studyInstanceUID: "study.1", seriesInstanceUIDs: ["series.a", "series.c"] },
        { order: 1, studyInstanceUID: "study.2" },
      ],
    },
    "/api/dicomweb"
  );
  assert.deepEqual(
    hints.map((item) => item.seriesInstanceUID),
    ["series.a", "series.b", "series.c"]
  );
  assert.equal(hints.every((item) => item.instanceCount == null), true);
  assert.equal(hints.every((item) => item.thumbnailInstanceUID == null), true);
  assert.equal(hints[0]?.modality, "CT");
});

test("merging the rail keeps the open series in place and prefers a positive count", () => {
  const current: CaseSeries[] = [
    {
      seriesInstanceUID: "open",
      studyInstanceUID: "study",
      wadoRsRoot: "/api/dicomweb",
    },
  ];
  const incoming: CaseSeries[] = [
    {
      seriesInstanceUID: "later",
      studyInstanceUID: "study",
      wadoRsRoot: "/api/dicomweb",
      instanceCount: 0,
      description: "Later",
    },
    {
      seriesInstanceUID: "open",
      studyInstanceUID: "study",
      wadoRsRoot: "/api/dicomweb",
      instanceCount: 1000,
      description: "Active",
      thumbnailInstanceUID: "sop.1",
    },
  ];
  const merged = mergeSeriesRail(current, incoming);
  assert.deepEqual(
    merged.map((item) => item.seriesInstanceUID),
    ["open", "later"]
  );
  assert.equal(merged[0]?.instanceCount, 1000);
  assert.equal(merged[0]?.description, "Active");
  assert.equal(merged[1]?.instanceCount, undefined);
});
