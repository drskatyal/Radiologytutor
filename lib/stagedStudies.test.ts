import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeUpload, totalStagedImages } from "../components/cases/stagedStudies";
import type { UploadResult } from "../components/admin/types";

const batch = (series: { uid: string; n: number }[]): UploadResult => ({
  stored: series.reduce((m, s) => m + s.n, 0),
  failed: [],
  skipped: [],
  series: series.map((s) => ({
    studyInstanceUID: "1.2.3",
    seriesInstanceUID: s.uid,
    studyDescription: "MR BRAIN",
    seriesDescription: s.uid,
    modality: "MR",
    instances: s.n,
  })) as UploadResult["series"],
});

test("batches add up once, even when React runs the updater twice", () => {
  let staged = mergeUpload([], batch([{ uid: "a", n: 20 }])).next;
  const second = batch([{ uid: "a", n: 4 }, { uid: "b", n: 16 }]);
  mergeUpload(staged, second); // StrictMode's discarded first run
  staged = mergeUpload(staged, second).next;
  assert.equal(totalStagedImages(staged), 40);
  assert.deepEqual(staged[0]!.series.map((s) => s.instanceCount), [24, 16]);
});

test("every uploaded series is selected; the first is primary", () => {
  let staged = mergeUpload([], batch([{ uid: "a", n: 1 }, { uid: "b", n: 1 }])).next;
  staged = mergeUpload(staged, batch([{ uid: "c", n: 1 }])).next;
  assert.deepEqual(staged[0]!.selected, ["a", "b", "c"]);
  assert.equal(staged[0]!.primary, "a");
});
