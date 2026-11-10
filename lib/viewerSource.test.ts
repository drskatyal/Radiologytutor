import { test } from "node:test";
import assert from "node:assert/strict";
import {
  caseSeriesToSource,
  viewerSourceKey,
  BUNDLED_CASE,
  BUNDLED_CASE_SERIES,
  BUNDLED_STUDY_UID,
  type CaseSeries,
} from "./viewerSource.ts";

test("caseSeriesToSource resolves a wadors series through the proxy root", () => {
  const s: CaseSeries = {
    seriesInstanceUID: "1.2.3.series",
    studyInstanceUID: "1.2.3.study",
    modality: "CT",
    instanceCount: 120,
    wadoRsRoot: "/api/dicomweb",
  };
  const src = caseSeriesToSource(s);
  assert.equal(src.kind, "wadors");
  assert.deepEqual(src, {
    kind: "wadors",
    wadoRsRoot: "/api/dicomweb",
    StudyInstanceUID: "1.2.3.study",
    SeriesInstanceUID: "1.2.3.series",
  });
});

test("viewerSourceKey ignores object identity for the same series", () => {
  const s: CaseSeries = {
    seriesInstanceUID: "1.2.3.series",
    studyInstanceUID: "1.2.3.study",
    modality: "CT",
    instanceCount: 65,
    wadoRsRoot: "/api/dicomweb",
  };
  const a = caseSeriesToSource(s);
  const b = caseSeriesToSource(s);
  assert.notEqual(a, b);
  assert.equal(viewerSourceKey(a), viewerSourceKey(b));
  const other = caseSeriesToSource({ ...s, seriesInstanceUID: "1.2.3.other" });
  assert.notEqual(viewerSourceKey(a), viewerSourceKey(other));
});

test("caseSeriesToSource resolves the bundled sentinel to the offline sample", () => {
  const src = caseSeriesToSource(BUNDLED_CASE_SERIES[0]);
  assert.deepEqual(src, BUNDLED_CASE);
});

test("the bundled series is a single-series rail anchored to the sentinel study", () => {
  assert.equal(BUNDLED_CASE_SERIES.length, 1);
  assert.equal(BUNDLED_CASE_SERIES[0].studyInstanceUID, BUNDLED_STUDY_UID);
  assert.equal(
    BUNDLED_CASE_SERIES[0].instanceCount,
    BUNDLED_CASE.kind === "wadouri" ? BUNDLED_CASE.frames : 0
  );
});

test("seriesForSource: the bundled sample is its 1-series case, a WADO-RS series is itself, local stacks none", async () => {
  const { seriesForSource, BUNDLED_CASE, BUNDLED_CASE_SERIES } = await import("./viewerSource");
  assert.deepEqual(seriesForSource(BUNDLED_CASE), BUNDLED_CASE_SERIES);
  assert.deepEqual(seriesForSource({ kind: "wadouri", url: "/other.dcm", frames: 3 }), []);
  assert.deepEqual(
    seriesForSource({ kind: "wadors", wadoRsRoot: "/api/dicomweb", StudyInstanceUID: "1.2", SeriesInstanceUID: "1.2.3" }),
    [{ seriesInstanceUID: "1.2.3", studyInstanceUID: "1.2", wadoRsRoot: "/api/dicomweb" }]
  );
  assert.deepEqual(seriesForSource({ kind: "imageIds", key: "k", imageIds: ["a"] }), []);
});
