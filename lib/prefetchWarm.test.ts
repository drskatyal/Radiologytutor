import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { WADORS_FRAME_ACCEPT } from "./dicomwebProxy.ts";
import {
  WARM_CAP,
  WARM_CONCURRENCY,
  collectFocusSlices,
  selectWarmTargets,
  wadoFrameUrl,
  type WarmSeries,
} from "./prefetchWarm.ts";

function seriesOf(count: number, seriesInstanceUID = "1.2.840.series"): WarmSeries {
  return {
    studyInstanceUID: "1.2.840.study",
    seriesInstanceUID,
    instances: Array.from({ length: count }, (_, i) => ({
      sopInstanceUID: `1.2.840.sop.${i}`,
    })),
  };
}

test("LIDC findings focus the warmer on their own slices: 34, the apical nodule on 6, and 64", () => {
  const seed = JSON.parse(
    readFileSync(new URL("../seed/case-lidc-nodule-search.json", import.meta.url), "utf8")
  ) as { findings: { seriesInstanceUID?: string; sliceIndex?: number; order?: number }[] };
  const focus = collectFocusSlices(seed.findings);
  assert.deepEqual(
    focus.map((item) => item.sliceIndex),
    [34, 6, 64]
  );
});

test("a 1000-slice series warms only the active open window, not other series", () => {
  const active = seriesOf(1000, "1.2.840.active");
  const other = seriesOf(1000, "1.2.840.other");
  const focus = collectFocusSlices([
    { order: 1, seriesInstanceUID: active.seriesInstanceUID, sliceIndex: 34 },
    { order: 2, seriesInstanceUID: other.seriesInstanceUID, sliceIndex: 10 },
  ]);
  const targets = selectWarmTargets([active, other], focus);
  const indexes = targets.map((target) =>
    Number(target.sopInstanceUID.slice(target.sopInstanceUID.lastIndexOf(".") + 1))
  );

  assert.ok(indexes.includes(500), "viewport opens at the middle");
  assert.ok(indexes.every((index) => index >= 490 && index <= 510), "±10 open window");
  assert.ok(!indexes.includes(0), "apex is not prefetched");
  assert.ok(!indexes.includes(34), "a distant finding is not prefetched");
  assert.ok(targets.every((target) => target.seriesInstanceUID === active.seriesInstanceUID));
  assert.ok(targets.length <= WARM_CAP);
  assert.equal(targets.length, 21, "the opening slice ±10");
  assert.ok(WARM_CONCURRENCY <= 4);
});

test("warm targets skip an empty SOP inside the open window", () => {
  const stack = seriesOf(10);
  stack.instances[5] = { sopInstanceUID: "  " };
  const targets = selectWarmTargets([stack], [], { radius: 1, cap: 8 });
  const sops = targets.map((target) => target.sopInstanceUID);
  assert.deepEqual(sops, ["1.2.840.sop.4", "1.2.840.sop.6"]);
});

test("frame URL matches the viewer imageId and the loader Accept", () => {
  const url = wadoFrameUrl("/api/dicomweb", {
    studyInstanceUID: "1.2.3",
    seriesInstanceUID: "4.5",
    sopInstanceUID: "6.7",
  });
  assert.equal(url, "/api/dicomweb/studies/1.2.3/series/4.5/instances/6.7/frames/1");
  assert.equal(
    WADORS_FRAME_ACCEPT,
    "multipart/related; type=application/octet-stream; transfer-syntax=*"
  );
});
