import assert from "node:assert/strict";
import { test } from "node:test";

import { stackOpenIndex } from "./stackIndex.ts";
import {
  fetchSeriesRailStats,
  presentSeriesRail,
  railStatsBySeries,
  railStatsFromDicomJson,
  railStatsFromInstances,
  seriesInstanceSearchUrl,
  seriesThumbUrl,
  type RailStats,
} from "./seriesRail.ts";
import type { CaseSeries } from "./viewerSource.ts";

const study = "1.2.826.0.1.3680043.8.498.study";

function series(uid: string, instanceCount = 0, thumbnailInstanceUID?: string): CaseSeries {
  return {
    seriesInstanceUID: uid,
    studyInstanceUID: study,
    modality: "MR",
    description: "Ax T2",
    seriesNumber: 2,
    instanceCount,
    thumbnailInstanceUID,
    wadoRsRoot: "/api/dicomweb",
  };
}

test("instance count ignores a missing NumberOfSeriesRelatedInstances and picks the middle slice", () => {
  // QIDO series headers on Healthcare omit 0020,1209. The list is the count.
  const stats = railStatsFromInstances([
    { sopInstanceUID: "1.2.sop.10", instanceNumber: 10 },
    { sopInstanceUID: "1.2.sop.30", instanceNumber: 30 },
    { sopInstanceUID: "1.2.sop.20", instanceNumber: 20 },
    { sopInstanceUID: "1.2.sop.40", instanceNumber: 40 },
    { sopInstanceUID: "1.2.sop.50", instanceNumber: 50 },
  ]);
  assert.equal(stats.instanceCount, 5);
  assert.equal(stackOpenIndex(5), 2);
  assert.equal(stats.thumbnailInstanceUID, "1.2.sop.30");
});

test("DICOM JSON metadata supplies count and middle SOP when the count tag is absent", () => {
  const rows = [
    { "00080018": { vr: "UI", Value: ["1.2.sop.a"] }, "00200013": { vr: "IS", Value: ["3"] }, "00201209": { Value: ["0"] } },
    { "00080018": { vr: "UI", Value: ["1.2.sop.b"] }, "00200013": { vr: "IS", Value: ["1"] } },
    { "00080018": { vr: "UI", Value: ["1.2.sop.c"] }, "00200013": { vr: "IS", Value: ["2"] } },
    { "00080060": { vr: "CS", Value: ["MR"] } },
  ];
  const stats = railStatsFromDicomJson(rows);
  assert.equal(stats.instanceCount, 3);
  assert.equal(stats.thumbnailInstanceUID, "1.2.sop.c");
  assert.equal(railStatsFromDicomJson({ "00201209": { Value: ["0"] } }).instanceCount, 0);
});

test("a prefetch manifest fills only series that actually listed instances", () => {
  const known = railStatsBySeries([
    {
      seriesInstanceUID: "1.2.t1",
      instances: [
        { sopInstanceUID: "1.2.mid", instanceNumber: 1 },
        { sopInstanceUID: "1.2.apex", instanceNumber: 2 },
      ],
    },
    { seriesInstanceUID: "1.2.empty", instances: [] },
  ]);
  assert.equal(known["1.2.t1"]?.instanceCount, 2);
  assert.equal(known["1.2.t1"]?.thumbnailInstanceUID, "1.2.apex");
  assert.equal(known["1.2.empty"], undefined);
});

test("covers stay unrequested until the main image is ready, then use the middle slice", () => {
  const header = series("1.2.t2", 0);
  const known = {
    "1.2.t2": { instanceCount: 127, thumbnailInstanceUID: "1.2.middle" } satisfies RailStats,
  };
  const before = presentSeriesRail({
    series: [header],
    mainImageReady: false,
    known,
    fetched: {},
    failed: new Set(),
  });
  assert.equal(before[0]?.instanceCount, 127);
  assert.equal(before[0]?.thumbnailInstanceUID, undefined);
  assert.equal(before[0]?.countPending, false);
  assert.equal(before[0]?.thumbPending, true);
  assert.equal(seriesThumbUrl(before[0]!), null);

  const after = presentSeriesRail({
    series: [header],
    mainImageReady: true,
    known,
    fetched: {},
    failed: new Set(),
  });
  assert.equal(after[0]?.instanceCount, 127);
  assert.equal(after[0]?.thumbnailInstanceUID, "1.2.middle");
  assert.match(seriesThumbUrl(after[0]!) ?? "", /\/instances\/1\.2\.middle\/rendered\?viewport=96,96$/);
  assert.equal(after[0]?.thumbPending, false);
});

test("a header that still says 0 images stays pending until the post-paint lookup", () => {
  const header = series("1.2.flair", 0);
  const waiting = presentSeriesRail({
    series: [header],
    mainImageReady: false,
    known: {},
    fetched: {},
    failed: new Set(),
  });
  assert.equal(waiting[0]?.countPending, true);
  assert.equal(waiting[0]?.instanceCount, 0);
  assert.equal(waiting[0]?.thumbnailInstanceUID, undefined);

  // The frame the viewport becomes ready, before the lookup's state lands.
  const gap = presentSeriesRail({
    series: [header],
    mainImageReady: true,
    known: {},
    fetched: {},
    failed: new Set(),
  });
  assert.equal(gap[0]?.countPending, true);
  assert.equal(gap[0]?.thumbPending, true);
  assert.equal(seriesThumbUrl(gap[0]!), null);

  const settled = presentSeriesRail({
    series: [header],
    mainImageReady: true,
    known: {},
    fetched: { "1.2.flair": { instanceCount: 64, thumbnailInstanceUID: "1.2.slice.32" } },
    failed: new Set(),
  });
  assert.equal(settled[0]?.countPending, false);
  assert.equal(settled[0]?.instanceCount, 64);
  assert.equal(settled[0]?.thumbnailInstanceUID, "1.2.slice.32");
});

test("an empty instance QIDO falls through to WADO series metadata", async () => {
  const calls: string[] = [];
  const target = series("1.2.t1c");
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.includes("/instances?")) {
      return new Response("[]", { status: 200 });
    }
    const body = [
      { "00080018": { Value: ["1.2.sop.late"] }, "00200013": { Value: ["8"] } },
      { "00080018": { Value: ["1.2.sop.early"] }, "00200013": { Value: ["2"] } },
    ];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  const stats = await fetchSeriesRailStats(target, fetchImpl);
  assert.equal(calls.length, 2);
  assert.match(calls[0] ?? "", /\/instances\?/);
  assert.match(seriesInstanceSearchUrl(target), /includefield=00080018%2C00200013/);
  assert.match(calls[1] ?? "", /\/metadata$/);
  assert.equal(stats.instanceCount, 2);
  // Sorted 2 then 8. Middle of two is index 1.
  assert.equal(stats.thumbnailInstanceUID, "1.2.sop.late");
});

test("a populated instance QIDO does not download series metadata", async () => {
  const calls: string[] = [];
  const target = series("1.2.t1");
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const body = [
      { "00080018": { Value: ["1.2.only"] }, "00200013": { Value: ["1"] } },
    ];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const stats = await fetchSeriesRailStats(target, fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(stats.instanceCount, 1);
  assert.equal(stats.thumbnailInstanceUID, "1.2.only");
});
