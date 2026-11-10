import { test } from "node:test";
import assert from "node:assert/strict";
import type { LocalSeries, LocalStudy } from "@flowrad/viewer-core/localStudy";
import { seriesImageIds } from "./localDicomFiles";
import { cloudStudySource, localStudySource } from "./viewerStudySource";
import type { CaseSeries } from "./viewerSource";

const series = (uid: string, files: string[]): LocalSeries => ({
  seriesInstanceUID: uid,
  studyInstanceUID: "1.2.3",
  modality: "CT",
  seriesNumber: 2,
  description: "Chest",
  instances: files.map((fileName, i) => ({ fileName, sizeBytes: 1, instanceNumber: i + 1 })),
  imageCount: files.length,
});

const study: LocalStudy = { studyInstanceUID: "1.2.3", series: [series("1.2.3.4", ["a", "b"]), series("1.2.3.5", [])], imageCount: 2 };
const byFile = new Map<string, string[]>([
  ["a", ["dicomfile:0"]],
  ["b", ["dicomfile:1", "dicomfile:1?frame=1"]],
]);

test("local: imageIds and the pane source are exactly what the viewer built inline", () => {
  const src = localStudySource({ studies: [study], imageIdsByFile: byFile });
  assert.equal(src.kind, "local");
  const s0 = study.series[0]!;
  assert.deepEqual(src.imageIds(s0), seriesImageIds(s0, byFile));
  assert.deepEqual(src.viewerSource(s0), {
    kind: "imageIds",
    key: "1.2.3.4",
    imageIds: ["dicomfile:0", "dicomfile:1", "dicomfile:1?frame=1"],
  });
});

test("local: a series with nothing registered has no source (nothing to paint)", () => {
  const src = localStudySource({ studies: [study], imageIdsByFile: byFile });
  assert.equal(src.viewerSource(study.series[1]!), null);
  assert.equal(src.thumbnailUrl(study.series[0]!), null, "covers render on device");
});

test("local: files come from the injected viewer-core reader", async () => {
  let asked: string | null = null;
  const src = localStudySource({
    studies: [study],
    imageIdsByFile: byFile,
    seriesFiles: async (s) => {
      asked = s.seriesInstanceUID;
      return [];
    },
  });
  assert.ok(src.files);
  await src.files!(study.series[0]!);
  assert.equal(asked, "1.2.3.4");
  assert.equal(localStudySource({ studies: [], imageIdsByFile: byFile }).files, undefined);
});

const cs = (study: string, uid: string, extra: Partial<CaseSeries> = {}): CaseSeries => ({
  studyInstanceUID: study,
  seriesInstanceUID: uid,
  wadoRsRoot: "/api/dicomweb",
  ...extra,
});

test("cloud: series group into studies in arrival order, counts from the archive", () => {
  const src = cloudStudySource([
    cs("9.1", "9.1.1", { modality: "CT", instanceCount: 240, description: "Axial" }),
    cs("9.2", "9.2.1", { modality: "CT", instanceCount: 120 }),
    cs("9.1", "9.1.2", { modality: "CT" }),
  ]);
  assert.equal(src.kind, "cloud");
  assert.deepEqual(src.studies.map((s) => s.studyInstanceUID), ["9.1", "9.2"]);
  assert.deepEqual(src.studies[0]!.series.map((s) => s.seriesInstanceUID), ["9.1.1", "9.1.2"]);
  assert.equal(src.studies[0]!.series[0]!.imageCount, 240);
  assert.equal(src.studies[0]!.series[1]!.imageCount, 0, "unknown is 0, never a stale count");
  assert.equal(src.studies[0]!.imageCount, 240);
});

test("cloud: a pane gets a wadors source (dicomCdn bundle or progressiveStack inside the viewer)", () => {
  const src = cloudStudySource([cs("9.1", "9.1.1")]);
  const s = src.studies[0]!.series[0]!;
  assert.equal(src.imageIds(s), null, "the viewer resolves cloud imageIds itself");
  assert.deepEqual(src.viewerSource(s), {
    kind: "wadors",
    wadoRsRoot: "/api/dicomweb",
    StudyInstanceUID: "9.1",
    SeriesInstanceUID: "9.1.1",
  });
  assert.equal(src.files, undefined, "no file export from the archive");
});

test("cloud: thumbnails are the archive's rendered cover when one is named", () => {
  const src = cloudStudySource([cs("9.1", "9.1.1", { thumbnailInstanceUID: "9.1.1.7" }), cs("9.1", "9.1.2")]);
  assert.match(src.thumbnailUrl(src.studies[0]!.series[0]!) ?? "", /\/instances\/9\.1\.1\.7\/rendered\?viewport=96,96$/);
  assert.equal(src.thumbnailUrl(src.studies[0]!.series[1]!), null);
});

test("cloud: incomplete descriptors are skipped, not crashed on", () => {
  const src = cloudStudySource([cs("", "x"), cs("9.1", "")]);
  assert.equal(src.studies.length, 0);
});

test("cloud: a label names a single study (the case title), never several", async () => {
  const { cloudStudySource } = await import("./viewerStudySource");
  const one = [{ seriesInstanceUID: "1.1", studyInstanceUID: "9.1", wadoRsRoot: "/api/dicomweb" }];
  assert.equal(cloudStudySource(one, { label: "  Chest CT  " }).studies[0]!.description, "Chest CT");
  assert.equal(cloudStudySource(one).studies[0]!.description, undefined);
  const two = [...one, { seriesInstanceUID: "2.1", studyInstanceUID: "9.2", wadoRsRoot: "/api/dicomweb" }];
  const studies = cloudStudySource(two, { label: "Chest CT" }).studies;
  assert.deepEqual(studies.map((s) => s.description), [undefined, undefined]);
});
