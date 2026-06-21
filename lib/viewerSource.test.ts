import { test } from "node:test";
import assert from "node:assert/strict";
import {
  caseSeriesToSource,
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
