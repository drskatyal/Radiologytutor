import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseHangingProtocol,
  localComparePlan,
  orientationOf,
  priorOffsetMm,
  seriesSimilarity,
  type HpSeries,
  type HpStudy,
} from "../packages/viewer-core/src/hangingProtocols";
import { patientKeyOf, type LocalSeries, type LocalStudy } from "../packages/viewer-core/src/localStudy";

const s = (uid: string, modality: string, description: string, imageCount: number, extra: Partial<HpSeries> = {}): HpSeries => ({
  uid, modality, description, imageCount, orientation: "axial", ...extra,
});

test("orientation from IOP", () => {
  assert.equal(orientationOf([1, 0, 0, 0, 1, 0]), "axial");
  assert.equal(orientationOf([1, 0, 0, 0, 0, -1]), "coronal");
  assert.equal(orientationOf([0, 1, 0, 0, 0, -1]), "sagittal");
  assert.equal(orientationOf([1, 0, 0, 0, 0.7071, 0.7071]), "oblique");
  assert.equal(orientationOf(null), null);
});

test("CT chest: soft tissue + lung + reformats → 2×2; scout ignored", () => {
  const study: HpStudy = { uid: "st", series: [
    s("scout", "CT", "Topogram 0.6 T20f", 1),
    s("soft", "CT", "Chest 1.0 Br40", 320, { sliceThickness: 1 }),
    s("lung", "CT", "Lung 1.0 Bl57", 320, { sliceThickness: 1 }),
    s("cor", "CT", "Cor MPR 3mm", 120, { orientation: "coronal" }),
    s("sag", "CT", "Sag MPR 3mm", 110, { orientation: "sagittal" }),
    s("dose", "CT", "Dose Report", 1),
  ]};
  const p = chooseHangingProtocol([study])!;
  assert.equal(p.protocol, "ct");
  assert.deepEqual([p.rows, p.cols], [2, 2]);
  assert.deepEqual(p.cells, ["soft", "cor", "sag", "lung"]);
});

test("CT without reformats: soft + lung side by side, scrolling together", () => {
  const p = chooseHangingProtocol([{ uid: "st", series: [s("a", "CT", "Abdomen 3mm", 120), s("b", "CT", "Lung window", 120)] }])!;
  assert.deepEqual(p.cells, ["a", "b"]);
  assert.equal(p.syncScroll, true);
});

test("MR brain: T1, T2, FLAIR, DWI in reading order on 2×2", () => {
  const study: HpStudy = { uid: "mr", series: [
    s("loc", "MR", "3-plane loc", 3),
    s("dwi", "MR", "ep2d_diff b1000 trace", 25),
    s("flair", "MR", "t2_tirm_tra_dark-fluid FLAIR", 25),
    s("t2", "MR", "t2_tse_tra", 25),
    s("t1", "MR", "t1_se_tra", 25),
    s("t1c", "MR", "t1_se_tra post gad", 25),
  ]};
  const p = chooseHangingProtocol([study])!;
  assert.equal(p.protocol, "mr");
  assert.deepEqual(p.cells, ["t1", "t2", "flair", "dwi"]);
  assert.equal(p.syncScroll, true);
  assert.match(p.label, /T1 · T2 · FLAIR · DWI/);
});

test("CR chest: PA then lateral, side by side", () => {
  const p = chooseHangingProtocol([{ uid: "cr", series: [s("lat", "CR", "Chest LAT", 1), s("pa", "CR", "Chest PA", 1)] }])!;
  assert.equal(p.protocol, "projection");
  assert.deepEqual(p.cells, ["pa", "lat"]);
  assert.deepEqual([p.rows, p.cols], [1, 2]);
});

test("current vs prior: newest left, matched series right, synced, registered by superior end", () => {
  const current: HpStudy = { uid: "now", date: "20260301", patientId: "P", series: [
    s("c-ax", "CT", "Chest 1.0 Br40", 300, { sliceThickness: 1, zRange: [-400, -100] }),
    s("c-lung", "CT", "Lung 1.0", 300, { sliceThickness: 1 }),
  ]};
  const prior: HpStudy = { uid: "then", date: "20250301", patientId: "P", series: [
    s("p-lung", "CT", "Lung 1.25", 240, { sliceThickness: 1.25 }),
    s("p-ax", "CT", "Chest 1.25 Br40", 240, { sliceThickness: 1.25, zRange: [-380, -90] }),
  ]};
  const p = chooseHangingProtocol([prior, current])!;
  assert.equal(p.protocol, "compare");
  assert.deepEqual(p.cells, ["c-ax", "p-ax"]);
  assert.equal(p.syncScroll, true);
  assert.equal(p.compare!.priorOffsetMm, 10);
  assert.match(p.label, /2026-03-01 vs prior 2025-03-01/);
});

test("different patients are never paired", () => {
  const a: HpStudy = { uid: "a", date: "20260301", patientId: "A", series: [s("1", "CT", "Chest", 100)] };
  const b: HpStudy = { uid: "b", date: "20250301", patientId: "B", series: [s("2", "CT", "Chest", 100)] };
  assert.equal(chooseHangingProtocol([a, b])!.protocol, "ct");
});

test("similarity and offset helpers", () => {
  assert.equal(seriesSimilarity(s("a", "CT", "x", 1), s("b", "MR", "x", 1)), 0);
  assert.ok(seriesSimilarity(s("a", "CT", "Chest Br40", 1), s("b", "CT", "Chest Br40", 1)) > 0.7);
  assert.equal(priorOffsetMm(s("a", "CT", "", 1), s("b", "CT", "", 1)), 0);
});

test("unknown modality keeps the app default", () => {
  assert.equal(chooseHangingProtocol([{ uid: "x", series: [s("a", "SR", "Report", 1)] }]), null);
});

test("local-study adapter: a single-viewport viewer opens on the protocol's primary series", async () => {
  const { primarySeriesIndexByProtocol } = await import("../packages/viewer-core/src/hangingProtocols");
  const inst = (z: number) => ({ imagePositionPatient: [0, 0, z], imageOrientationPatient: [1, 0, 0, 0, 1, 0] });
  const study = {
    studyInstanceUID: "s", studyDate: "20260101", imageCount: 0,
    series: [
      { seriesInstanceUID: "scout", studyInstanceUID: "s", modality: "CT", description: "Topogram", imageCount: 1, instances: [inst(0)] },
      { seriesInstanceUID: "ax", studyInstanceUID: "s", modality: "CT", description: "Abdomen 1.0", imageCount: 200, instances: [inst(0), inst(1)] },
    ],
  };
  assert.equal(primarySeriesIndexByProtocol(study as never), 1);
});

// ── The web viewer's current-vs-prior hanging (localComparePlan) ──


const localSeries = (studyUid: string, uid: string, description: string, count: number, z0: number): LocalSeries => ({
  seriesInstanceUID: uid,
  studyInstanceUID: studyUid,
  modality: "CT",
  description,
  imageCount: count,
  instances: Array.from({ length: count }, (_, i) => ({
    fileName: `${uid}/${i}`,
    sizeBytes: 1,
    imageOrientationPatient: [1, 0, 0, 0, 1, 0],
    imagePositionPatient: [0, 0, z0 - i * 5],
  })),
});
const localStudy = (uid: string, date: string, patient: string | undefined, series: LocalSeries[]): LocalStudy => ({
  studyInstanceUID: uid,
  studyDate: date,
  patientKey: patientKeyOf(patient),
  series,
  imageCount: series.reduce((n, x) => n + x.imageCount, 0),
});

test("patient key: one-way, stable, none without an ID", () => {
  const k = patientKeyOf("CI-0001")!;
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(patientKeyOf(" CI-0001 "), k);
  assert.notEqual(patientKeyOf("CI-0002"), k);
  assert.ok(!k.includes("0001"));
  assert.equal(patientKeyOf(""), undefined);
  assert.equal(patientKeyOf(undefined), undefined);
});

test("local compare: the newest study's primary series beside the matching prior series", () => {
  // Opened in any order: the prior first here.
  const prior = localStudy("p", "20230105", "CI-0001", [localSeries("p", "p-lung", "Lung 1mm", 40, 100), localSeries("p", "p-soft", "Abdomen 3mm", 40, 120)]);
  const current = localStudy("c", "20240312", "CI-0001", [localSeries("c", "c-soft", "Abdomen 3mm", 40, 150), localSeries("c", "c-scout", "Topogram", 1, 0)]);
  const plan = localComparePlan([prior, current])!;
  assert.deepEqual(plan.current, { study: 1, series: 0 });
  assert.deepEqual(plan.prior, { study: 0, series: 1 });
  assert.equal(plan.label, "Current 2024-03-12 vs prior 2023-01-05");
  // Superior ends aligned: the prior's top (120) is 30 mm below the current's (150).
  assert.equal(plan.priorOffsetMm, -30);
});

test("local compare: never another patient's study, a same-day study, or a single study", () => {
  const current = localStudy("c", "20240312", "CI-0001", [localSeries("c", "c-soft", "Abdomen 3mm", 40, 150)]);
  const other = localStudy("o", "20230105", "CI-0002", [localSeries("o", "o-soft", "Abdomen 3mm", 40, 120)]);
  const sameDay = localStudy("s", "20240312", "CI-0001", [localSeries("s", "s-soft", "Abdomen 3mm", 40, 120)]);
  assert.equal(localComparePlan([current, other]), null);
  assert.equal(localComparePlan([current, sameDay]), null);
  assert.equal(localComparePlan([current]), null);
});
