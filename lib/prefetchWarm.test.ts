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

test("LIDC findings focus the warmer on 34, 49, and 64 — not the apex", () => {
  const seed = JSON.parse(
    readFileSync(new URL("../seed/case-lidc-nodule-search.json", import.meta.url), "utf8")
  ) as { findings: { seriesInstanceUID?: string; sliceIndex?: number; order?: number }[] };
  const focus = collectFocusSlices(seed.findings);
  assert.deepEqual(
    focus.map((item) => item.sliceIndex),
    [34, 49, 64]
  );
});

test("a 65-slice chest warms the open slice and the nodule, not the first 32", () => {
  const stack = seriesOf(65);
  const focus = collectFocusSlices([
    { order: 1, seriesInstanceUID: stack.seriesInstanceUID, sliceIndex: 34 },
    { order: 2, seriesInstanceUID: stack.seriesInstanceUID, sliceIndex: 49 },
    { order: 3, seriesInstanceUID: stack.seriesInstanceUID, sliceIndex: 64 },
  ]);
  const targets = selectWarmTargets([stack], focus);
  const indexes = targets.map((target) =>
    Number(target.sopInstanceUID.slice(target.sopInstanceUID.lastIndexOf(".") + 1))
  );

  assert.ok(indexes.includes(32), "viewport opens at the middle");
  assert.ok(indexes.includes(34), "finding 1");
  assert.ok(indexes.includes(49), "finding 2");
  assert.ok(indexes.includes(64), "finding 3");
  assert.ok(!indexes.includes(0), "apex is not on the teach path");
  assert.ok(targets.length <= WARM_CAP);
  assert.ok(targets.length < 32);
  assert.ok(WARM_CONCURRENCY <= 4);
});

test("warm targets skip empty SOPs and clamp a slice past the end of the stack", () => {
  const stack = seriesOf(10);
  stack.instances[5] = { sopInstanceUID: "  " };
  const targets = selectWarmTargets(
    [stack],
    [{ seriesInstanceUID: stack.seriesInstanceUID, sliceIndex: 99 }],
    { radius: 0, cap: 8 }
  );
  const sops = targets.map((target) => target.sopInstanceUID);
  assert.ok(sops.includes("1.2.840.sop.9"));
  assert.ok(!sops.includes("1.2.840.sop.5"));
  assert.equal(new Set(sops).size, sops.length);
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
