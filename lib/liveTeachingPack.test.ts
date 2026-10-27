import { test } from "node:test";
import assert from "node:assert/strict";
import { HARNESS_VIEWER_TOOLS } from "./harness/tools.ts";
import {
  SET_SERIES_PARAMETERS,
  guardSetSeries,
  livePackInstruction,
  livePackTools,
  liveSessionKick,
  materializeLiveTeachingPack,
  nextFindingId,
  resolveLiveTeachingPack,
  validateLiveToolCall,
  LIVE_PACK_TOOLS,
} from "./liveTeachingPack.ts";
import type { Finding, RecordedTrack } from "./types.ts";

function finding(partial: Partial<Finding> & Pick<Finding, "id" | "label">): Finding {
  return {
    description: "",
    teachingPoints: [],
    state: " ",
    marker: { x_pct: 0.4, y_pct: 0.5, shape: "circle" },
    order: 1,
    ...partial,
  };
}

const track: RecordedTrack = {
  durationMs: 1000,
  start: { sliceIndex: 3, ww: 1500, wc: -600 },
  events: [
    { t: 10, type: "series", seriesInstanceUID: "1.2.t2" },
    { t: 20, type: "series", seriesInstanceUID: "1.2.dwi" },
  ],
};

test("set_series keeps the sidepane argument names and stays off the harness list", () => {
  const tool = LIVE_PACK_TOOLS.find((item) => item.name === "set_series");
  assert.ok(tool);
  assert.deepEqual(tool?.parameters, SET_SERIES_PARAMETERS);
  const props = (SET_SERIES_PARAMETERS.properties ?? {}) as Record<string, unknown>;
  assert.deepEqual(Object.keys(props).sort(), ["seriesInstanceUID", "sliceIndex", "wc", "ww"]);
  assert.deepEqual(SET_SERIES_PARAMETERS.required, ["seriesInstanceUID"]);
  const names = LIVE_PACK_TOOLS.map((item) => item.name).sort();
  assert.deepEqual(names, [
    "draw_annotation",
    "next_finding",
    "point_to",
    "scroll_to",
    "set_series",
    "set_window",
    "show_finding",
    "web_search",
    "zoom_to",
  ]);
  assert.equal(
    HARNESS_VIEWER_TOOLS.some((item) => item.name === "set_series"),
    false
  );
});

test("drive anchors come from the finding, never from model prose", () => {
  const pack = materializeLiveTeachingPack({
    caseId: "c1",
    modality: "MR",
    diagnosis: "Acute infarct",
    findings: [
      finding({
        id: "f-late",
        label: "Chronic lacune",
        description: "Old CSF space.",
        teachingPoints: ["Do not call this acute."],
        order: 2,
        seriesInstanceUID: "1.2.flair",
        sliceIndex: 12,
        windowWidth: 80,
        windowCenter: 40,
        marker: { x_pct: 0.2, y_pct: 0.3, shape: "circle" },
      }),
      finding({
        id: "f-acute",
        label: "Restricted diffusion",
        description: "Bright on DWI.",
        teachingPoints: ["Confirm on ADC."],
        order: 1,
        seriesInstanceUID: "1.2.dwi",
        sliceIndex: 8,
        windowWidth: 1000,
        windowCenter: 500,
        marker: { x_pct: 0.62, y_pct: 0.41, shape: "circle" },
        track,
        anchors: [
          {
            seriesInstanceUID: "1.2.dwi",
            sliceIndex: 8,
            marker: { x_pct: 0.62, y_pct: 0.41, shape: "circle" },
            viewportRole: "primary",
          },
          {
            seriesInstanceUID: "1.2.adc",
            sliceIndex: 8,
            marker: { x_pct: 0.6, y_pct: 0.4, shape: "circle" },
            viewportRole: "compare",
          },
        ],
      }),
    ],
    prose: [
      {
        id: "f-acute",
        whatToNotice: "Cortical brightness",
        pearl: "Match it on ADC",
        mimics: ["T2 shine-through"],
        clinicalImportance: 1,
        whyClinicallyFirst: "Acute stroke is first.",
        reportLine: "Restricted diffusion in the left MCA cortex.",
        sliceIndex: 99,
        seriesInstanceUID: "1.2.evil",
        marker: { x_pct: 0.99, y_pct: 0.01 },
      } as never,
    ],
    studySeriesUIDs: ["1.2.t1"],
  });

  assert.deepEqual(pack.findingOrder, ["f-acute", "f-late"]);
  const acute = pack.findings[0];
  assert.equal(acute?.whatToNotice, "Cortical brightness");
  assert.equal(acute?.pearl, "Match it on ADC");
  assert.deepEqual(acute?.mimics, ["T2 shine-through"]);
  assert.equal(acute?.drive.sliceIndex, 8);
  assert.equal(acute?.drive.seriesInstanceUID, "1.2.dwi");
  assert.equal(acute?.drive.marker?.x_pct, 0.62);
  assert.equal(acute?.drive.compare?.seriesInstanceUID, "1.2.adc");
  assert.equal(JSON.stringify(pack).includes("1.2.evil"), false);
  assert.equal(JSON.stringify(pack).includes("0.99"), false);
  assert.ok(pack.authoredSeriesInstanceUIDs.includes("1.2.t1"));
  assert.ok(pack.authoredSeriesInstanceUIDs.includes("1.2.t2"));
  assert.ok(pack.authoredSeriesInstanceUIDs.includes("1.2.adc"));
  assert.equal(pack.authoredSeriesInstanceUIDs.includes("1.2.evil"), false);
});

test("set_series rejects a series the teacher did not author", () => {
  const allowed = ["1.2.dwi", "1.2.flair"];
  const rejected = guardSetSeries(allowed, { seriesInstanceUID: "1.2.evil", sliceIndex: 4, ww: 80, wc: 40 });
  assert.equal(rejected.ok, false);
  const missing = guardSetSeries(allowed, { sliceIndex: 3 });
  assert.equal(missing.ok, false);
  const unloaded = guardSetSeries(allowed, { seriesInstanceUID: "1.2.flair", sliceIndex: 2.2, ww: 80 }, ["1.2.dwi"]);
  assert.equal(unloaded.ok, false);
  const accepted = guardSetSeries(allowed, { seriesInstanceUID: "1.2.flair", sliceIndex: 2.2, ww: 90, wc: 45 }, [
    "1.2.dwi",
    "1.2.flair",
  ]);
  assert.deepEqual(accepted, { ok: true, seriesInstanceUID: "1.2.flair", sliceIndex: 2, ww: 90, wc: 45 });
});

test("resolve rebuilds drive after a teacher edit and keeps Flash prose", () => {
  const first = materializeLiveTeachingPack({
    caseId: "c1",
    modality: "CT",
    findings: [
      finding({
        id: "f1",
        label: "Nodule",
        description: "Solid.",
        order: 1,
        seriesInstanceUID: "1.2.lung",
        sliceIndex: 4,
        marker: { x_pct: 0.2, y_pct: 0.2, shape: "circle" },
      }),
    ],
    prose: [{ id: "f1", whatToNotice: "Round opacity", clinicalImportance: 1, whyClinicallyFirst: "Only finding." }],
  });
  const edited = finding({
    id: "f1",
    label: "Nodule",
    description: "Solid.",
    order: 1,
    seriesInstanceUID: "1.2.lung",
    sliceIndex: 9,
    marker: { x_pct: 0.33, y_pct: 0.44, shape: "circle" },
  });
  const resolved = resolveLiveTeachingPack({
    caseId: "c1",
    modality: "CT",
    findings: [edited],
    liveTeachingPack: {
      ...first,
      findings: [
        {
          ...first.findings[0]!,
          drive: { seriesInstanceUID: "1.2.invented", sliceIndex: 99, marker: { x_pct: 0.99, y_pct: 0.01 } },
        },
      ],
    },
  });
  assert.equal(resolved.findings[0]?.whatToNotice, "Round opacity");
  assert.equal(resolved.findings[0]?.whyClinicallyFirst, "Only finding.");
  assert.equal(resolved.findings[0]?.drive.sliceIndex, 9);
  assert.equal(resolved.findings[0]?.drive.marker?.x_pct, 0.33);
  assert.equal(resolved.authoredSeriesInstanceUIDs.includes("1.2.invented"), false);
  assert.equal(nextFindingId(resolved, null), "f1");
  assert.equal(nextFindingId(resolved, "f1"), null);
});

test("invented slice and series are rejected; show_finding returns the authored drive", () => {
  const pack = materializeLiveTeachingPack({
    caseId: "c1",
    modality: "MR",
    findings: [
      finding({
        id: "f-acute",
        label: "Restricted diffusion",
        order: 1,
        seriesInstanceUID: "1.2.dwi",
        sliceIndex: 8,
        windowWidth: 1000,
        windowCenter: 500,
        marker: { x_pct: 0.62, y_pct: 0.41, shape: "circle" },
      }),
    ],
  });
  const invented = validateLiveToolCall(pack, "set_series", {
    seriesInstanceUID: "1.2.dwi",
    sliceIndex: 99,
    ww: 1000,
    wc: 500,
  });
  assert.equal(invented.ok, false);
  const evil = validateLiveToolCall(pack, "set_series", { seriesInstanceUID: "1.2.evil" });
  assert.equal(evil.ok, false);
  const seated = validateLiveToolCall(pack, "show_finding", { findingId: "f-acute" });
  assert.equal(seated.ok, true);
  if (seated.ok) {
    assert.equal(seated.sliceIndex, 8);
    assert.equal(seated.seriesInstanceUID, "1.2.dwi");
    assert.equal(seated.drive?.marker?.x_pct, 0.62);
  }
  const copied = validateLiveToolCall(pack, "set_series", {
    seriesInstanceUID: "1.2.dwi",
    sliceIndex: 8,
    ww: 1000,
    wc: 500,
  });
  assert.equal(copied.ok, true);
  if (copied.ok) assert.equal(copied.sliceIndex, 8);
  const tools = livePackTools(pack.authoredSeriesInstanceUIDs);
  assert.equal(tools.length, LIVE_PACK_TOOLS.length);
  assert.match(tools.find((tool) => tool.name === "set_series")?.description ?? "", /1\.2\.dwi/);
  assert.equal(livePackInstruction(pack, "teach_me").includes("1.2.dwi"), false);
});

test("examiner prompt withholds the diagnosis and teach-me requires a drive tool", () => {
  const pack = materializeLiveTeachingPack({
    caseId: "c1",
    modality: "CT",
    diagnosis: "Right upper lobe carcinoma",
    clinicalQuestion: "Cough and weight loss",
    findings: [finding({ id: "f1", label: "Spiculated nodule", order: 1, seriesInstanceUID: "1.2.lung" })],
  });
  const teach = livePackInstruction(pack, "teach_me", "LIDC");
  const exam = livePackInstruction(pack, "examiner", "LIDC");
  assert.match(teach, /Teach me the case/);
  assert.match(teach, /MUST call/);
  assert.match(teach, /set_series/);
  assert.match(teach, /Right upper lobe carcinoma/);
  assert.match(teach, /Scrolling does not start teaching/);
  assert.equal(teach.includes("1.2.lung"), false);
  assert.match(teach, /tool result/);
  assert.match(exam, /ACTIVE MODE: Examiner/);
  assert.match(exam, /Hint ladder/);
  assert.equal(exam.includes("Right upper lobe carcinoma"), false);
  assert.match(liveSessionKick("teach_me"), /findingOrder/);
  assert.match(liveSessionKick("examiner"), /do not name the diagnosis/i);
});
