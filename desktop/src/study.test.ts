// Series grouping off the long-task list (the 10,310-image MRI open).
//
// `buildStudiesSliced` must give exactly what `buildStudies` gave before it
// was sliced: the same studies, series, slice order and primary series. The
// fixture is the CI's synthetic MRI (scripts/make-big-study.py mri): one
// 192-slice sagittal 3D series plus 2D axial / coronal / sagittal series of
// 24-60 images, 10,310 images in 242 series, arriving in scan (not series) order.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runSliced, runToCompletion } from "@flowrad/viewer-core";
import { buildStudies, buildStudiesSliced, buildStudiesSteps, primarySeriesIndex } from "./study";
import { LONG_TASK_MS } from "./perfWatch";
import type { DesktopHeader, ViewerStudy } from "./types";

/** scripts/make-big-study.py mri, as headers. */
function syntheticMri(images = 10_310): DesktopHeader[] {
  const plan: [number, "axial" | "coronal" | "sagittal", number, number][] = [[1, "sagittal", 192, 1]];
  const planes = ["axial", "coronal", "sagittal"] as const;
  for (let total = 192, s = 2; total < images; s += 1) {
    const n = Math.min(24 + ((s * 7) % 37), images - total);
    plan.push([s, planes[s % 3], n, 5]);
    total += n;
  }
  const out: DesktopHeader[] = [];
  const fov = 220;
  for (const [s, plane, n, thickness] of plan) {
    for (let i = 0; i < n; i += 1) {
      const t = (i / Math.max(1, n - 1)) * 2 - 1;
      const d = (t * n * thickness) / 2;
      const fileId = out.length + 1;
      out.push({
        fileName: `C:/bigmr/S${String(s).padStart(3, "0")}/MR${String(i).padStart(5, "0")}.dcm`,
        sizeBytes: 140_000,
        fileId,
        studyInstanceUID: "2.25.100",
        seriesInstanceUID: `2.25.100.${s}`,
        sopInstanceUID: `2.25.100.${s}.${i}`,
        frameOfReferenceUID: "2.25.101",
        modality: "MR",
        seriesNumber: s,
        instanceNumber: i + 1,
        seriesDescription: `${s === 1 ? "3D T1 " : ""}${plane} ${thickness} mm (series ${s})`,
        studyDescription: "Synthetic large MRI",
        patientName: "Synthetic^BigMR",
        patientId: "SYN-BIGMR",
        imageOrientationPatient:
          plane === "sagittal" ? [0, 1, 0, 0, 0, -1] : plane === "coronal" ? [1, 0, 0, 0, 0, -1] : [1, 0, 0, 0, 1, 0],
        imagePositionPatient:
          plane === "sagittal" ? [d, -fov / 2, fov / 2] : plane === "coronal" ? [-fov / 2, d, fov / 2] : [-fov / 2, -fov / 2, d],
        rows: 256,
        columns: 256,
        baseImageId: `wadouri:dicom://localhost/f/${fileId}`,
      });
    }
  }
  // Scan order, not series order: the parallel scan interleaves folders.
  // A fixed shuffle (LCG) keeps the test deterministic.
  let seed = 83;
  for (let i = out.length - 1; i > 0; i -= 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Everything the viewer reads from a build, as one digest. */
function fingerprint(studies: ViewerStudy[]): string {
  const hash = createHash("sha256");
  for (const st of studies) {
    hash.update(JSON.stringify([st.uid, st.description, st.date, st.modalities, st.imageCount, st.patient, primarySeriesIndex(st)]));
    for (const s of st.series) {
      hash.update(
        JSON.stringify([s.uid, s.studyUid, s.modality, s.number, s.description, s.imageCount, s.volumetric, s.multiframe, s.frameRate, s.frameOfReferenceUid])
      );
      hash.update(s.imageIds.join("\n"));
      hash.update(s.headers.map((h) => h.fileId).join(","));
    }
  }
  return hash.digest("hex");
}

// The output of `buildStudies` on this fixture BEFORE grouping was sliced
// (epic-noether-3nvcbf at 9621a5a): sliced or not, it must not move.
const MRI_FINGERPRINT_BEFORE_SLICING = "d0e2c1d0f2322dc77a1ef0f042b3b3645e645cc92856c991e3452aec66d67333";

/** Gives the thread back instantly: the tests count slices, not wait for them. */
const noWait = () => Promise.resolve();

test("the synthetic MRI groups into 242 series, 10,310 images, the 3D series primary", () => {
  const [study, ...rest] = buildStudies(syntheticMri());
  assert.equal(rest.length, 0);
  assert.equal(study.series.length, 242);
  assert.equal(study.imageCount, 10_310);
  assert.deepEqual(
    study.series.slice(0, 3).map((s) => s.number),
    [1, 2, 3]
  );
  const primary = study.series[primarySeriesIndex(study)];
  assert.equal(primary.number, 1);
  assert.equal(primary.imageCount, 192);
  assert.equal(primary.volumetric, true);
});

test("grouping the MRI gives the same result as before it was sliced", () => {
  assert.equal(fingerprint(buildStudies(syntheticMri())), MRI_FINGERPRINT_BEFORE_SLICING);
});

test("sliced grouping is identical to the synchronous build, however it is sliced", async () => {
  const headers = syntheticMri();
  const sync = buildStudies(headers);
  for (const budgetMs of [0, 1, 8, Infinity]) {
    const sliced = await buildStudiesSliced(headers, { budgetMs, yieldFn: noWait });
    assert.ok(sliced);
    assert.deepEqual(sliced, sync, `budget ${budgetMs} ms`);
    assert.equal(fingerprint(sliced), MRI_FINGERPRINT_BEFORE_SLICING);
    assert.equal(primarySeriesIndex(sliced[0]), primarySeriesIndex(sync[0]));
  }
});

test("sliced grouping is identical on mixed input: studies, missing UIDs, multiframe, ties", async () => {
  const base = { sizeBytes: 1, rows: 256, columns: 256, imageOrientationPatient: [1, 0, 0, 0, 1, 0] };
  const headers: DesktopHeader[] = [
    // Prior and current CT, axial (head-first flip), one with a scout at the same position.
    ...[0, 1, 2, 3].map((i) => ({ ...base, fileName: `/a/CT${i}`, fileId: 100 + i, studyInstanceUID: "1.1", studyDate: "20240101", seriesInstanceUID: "1.1.1", modality: "CT", seriesNumber: 2, instanceNumber: 4 - i, imagePositionPatient: [0, 0, i * 2.5], baseImageId: `b:${100 + i}` })),
    ...[0, 1, 2].map((i) => ({ ...base, fileName: `/b/CT${i}`, fileId: 200 + i, studyInstanceUID: "1.2", studyDate: "20250101", seriesInstanceUID: "1.2.1", modality: "ct", seriesNumber: 1, instanceNumber: i + 1, imagePositionPatient: [0, 0, 5], baseImageId: `b:${200 + i}` })),
    // A cine (multiframe) US and a loose file with no UIDs at all.
    { ...base, fileName: "/c/US1", fileId: 300, studyInstanceUID: "1.2", seriesInstanceUID: "1.2.9", modality: "US", numberOfFrames: 12, frameTime: 33.3, baseImageId: "b:300" },
    { ...base, fileName: "/loose/IM10", fileId: 400, modality: "OT", baseImageId: "b:400" },
    { ...base, fileName: "/loose/IM9", fileId: 401, modality: "OT", baseImageId: "b:401" },
    // A PET series (cross-sectional, but anatomy first) and no-number series.
    ...[0, 1, 2].map((i) => ({ ...base, fileName: `/p/PT${i}`, fileId: 500 + i, studyInstanceUID: "1.2", seriesInstanceUID: "1.2.5", modality: "PT", imagePositionPatient: [0, 0, i * 4], baseImageId: `b:${500 + i}` })),
  ];
  const sync = buildStudies(headers);
  for (const budgetMs of [0, Infinity]) {
    assert.deepEqual(await buildStudiesSliced(headers, { budgetMs, yieldFn: noWait }), sync);
  }
  assert.deepEqual(
    sync.map((st) => st.uid),
    ["1.2", "1.1", "local.unknown.study"]
  );
  assert.deepEqual(await buildStudiesSliced([], { yieldFn: noWait }), []);
});

test("the MRI build yields between series: no slice holds more than one step past its budget", async () => {
  const headers = syntheticMri();
  // Steps the work is cut into: ~10 grouping chunks + one per series ordered + one per series built.
  let steps = 0;
  const work = buildStudiesSteps(headers);
  while (!work.next().done) steps += 1;
  assert.ok(steps >= 2 * 242 + 10, `${steps} steps`);

  // A clock where every step costs 1 ms: an 8 ms budget yields every 8 steps.
  let clock = 0;
  let yields = 0;
  let stats: { slices: number; maxSliceMs: number } | undefined;
  const built = await runSliced(
    (function* () {
      const inner = buildStudiesSteps(headers);
      for (;;) {
        const step = inner.next();
        clock += 1;
        if (step.done) return step.value;
        yield;
      }
    })(),
    { budgetMs: 8, now: () => clock, yieldFn: async () => void (yields += 1), onStats: (s) => (stats = s) }
  );
  assert.deepEqual(built, buildStudies(headers));
  assert.ok(stats);
  assert.equal(stats.maxSliceMs, 8);
  assert.equal(stats.slices, yields + 1);
  assert.ok(yields >= Math.floor(steps / 8) - 1, `${yields} yields for ${steps} steps`);
});

test(`opening the MRI: grouping never holds the main thread for ${LONG_TASK_MS} ms (real clock)`, async () => {
  const headers = syntheticMri();
  // Cold (first, un-JITted) and warm runs; the gate is the slowest slice.
  for (let run = 0; run < 3; run += 1) {
    let maxSliceMs = Infinity;
    const built = await buildStudiesSliced(headers, { onStats: (s) => (maxSliceMs = s.maxSliceMs) });
    assert.equal(built?.[0].series.length, 242);
    assert.ok(maxSliceMs < LONG_TASK_MS, `run ${run + 1}: slowest grouping slice ${maxSliceMs.toFixed(1)} ms`);
  }
});

test("a superseded build stops at its next step and resolves undefined", async () => {
  const headers = syntheticMri(2_000);
  let checks = 0;
  const built = await buildStudiesSliced(headers, { budgetMs: 0, yieldFn: noWait, isCancelled: () => ++checks > 5 });
  assert.equal(built, undefined);
  assert.equal(checks, 6);
  // Run to completion it is the synchronous build.
  assert.deepEqual(runToCompletion(buildStudiesSteps(headers)), buildStudies(headers));
});
