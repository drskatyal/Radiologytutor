import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { orderStackDatasets } from "./stackOrder.ts";
import { firstTeacherSlice, stackIndexOfSop } from "./viewerLoad.ts";
import { LIDC_ANCHOR_SOPS } from "./publicCases/catalog.ts";
import { rebindStaleLidcCase } from "./lidcStoredAnatomy.ts";
import { secondaryAnchor } from "./findingAnchors.ts";
import type { Finding, TeachingGuide } from "./types.ts";

// Staging still has the pre-anatomy LIDC document (seedIfEmpty never rewrites
// an existing case). Finding 2 is slice 49 with no SOP: on the position-sorted
// stack that is Loc 324, the upper abdomen, not the apical nodule at Loc 109.
// The read path has to rebind that placeholder. It must not rewrite a stored
// document and it must not move an anchor an author already set.

const STUDY = "1.3.6.1.4.1.14519.5.2.1.6279.6001.210460865401632134346677582159";
const SERIES = "1.3.6.1.4.1.14519.5.2.1.6279.6001.314917368146772872954571551463";

interface FixtureInstance {
  instanceNumber: number;
  position: [number, number, number];
  sliceLocation: number;
  sopInstanceUID: string;
}
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/lidcStackGeometry.json", import.meta.url), "utf8")
) as { orientation: number[]; archiveOrder: FixtureInstance[] };
const stack = orderStackDatasets(
  fixture.archiveOrder.map((instance) => ({
    "00080018": { vr: "UI", Value: [instance.sopInstanceUID] },
    "00200013": { vr: "IS", Value: [instance.instanceNumber] },
    "00200032": { vr: "DS", Value: instance.position },
    "00200037": { vr: "DS", Value: fixture.orientation },
    "00201041": { vr: "DS", Value: [instance.sliceLocation] },
  }))
);
const imageIds = stack.map(
  (dataset) =>
    `wadors:/api/dicomweb/studies/${STUDY}/series/${SERIES}/instances/${dataset["00080018"].Value[0]}/frames/1`
);
const locOfSop = (sop: string) => stack[stackIndexOfSop(imageIds, sop)]!["00201041"].Value[0];

function guide(start: number, landing: number): TeachingGuide {
  return {
    durationMs: 1600,
    start: { sliceIndex: start, ww: 1500, wc: -600 },
    beats: [
      {
        t: 200,
        act: "orient",
        say: "Follow the stack.",
        actions: [{ type: "scroll", sliceIndex: landing, seriesInstanceUID: SERIES }],
      },
    ],
  };
}

function finding(partial: Partial<Finding> & Pick<Finding, "id" | "order" | "label" | "sliceIndex">): Finding {
  return {
    description: "",
    teachingPoints: [],
    state: " ",
    marker: { x_pct: 0.5, y_pct: 0.5, shape: "circle" },
    studyInstanceUID: STUDY,
    seriesInstanceUID: SERIES,
    ...partial,
  };
}

/** The document staging still serves: placeholder indices, no SOP. */
function stagingDocument() {
  return {
    id: "case-lidc-nodule-search",
    caseId: "case-lidc-nodule-search",
    title: "LIDC chest CT — systematic lung nodule search",
    modality: "CT",
    pacsbinBaseUrl: "/cornerstone",
    orgId: "org_demo",
    status: "published" as const,
    findings: [
      finding({
        id: "f_caselidcno_1",
        order: 1,
        label: "Lung window — start mid-chest",
        sliceIndex: 34,
        marker: { x_pct: 0.52, y_pct: 0.42, shape: "circle" },
        teachingGuide: guide(0, 34),
      }),
      finding({
        id: "f_caselidcno_2",
        order: 2,
        label: "Peripheral nodule survey",
        sliceIndex: 49,
        marker: { x_pct: 0.68, y_pct: 0.55, shape: "circle" },
        teachingGuide: guide(41, 49),
        anchors: [
          {
            studyInstanceUID: STUDY,
            seriesInstanceUID: SERIES,
            sliceIndex: 49,
            marker: { x_pct: 0.68, y_pct: 0.55, shape: "circle" },
            viewportRole: "primary",
            studyRole: "current",
          },
          {
            studyInstanceUID: STUDY,
            seriesInstanceUID: SERIES,
            sliceIndex: 47,
            marker: { x_pct: 0.68, y_pct: 0.55, shape: "circle" },
            viewportRole: "secondary",
            studyRole: "current",
          },
        ],
      }),
      finding({
        id: "f_caselidcno_3",
        order: 3,
        label: "Mediastinal window pass",
        sliceIndex: 64,
        windowWidth: 400,
        windowCenter: 40,
        teachingGuide: guide(56, 64),
      }),
    ],
  };
}

test("stored LIDC finding 2 opens on the apical nodule, not the upper abdomen", () => {
  const stale = stagingDocument();
  const abdomen = stack.find((dataset) => dataset["00201041"].Value[0] === 324)!;
  assert.equal(stackIndexOfSop(imageIds, abdomen["00080018"].Value[0]), 49);

  const repaired = rebindStaleLidcCase(stale);
  const nodule = repaired.findings.find((item) => item.order === 2)!;
  assert.equal(nodule.sopInstanceUID, LIDC_ANCHOR_SOPS.nodule);
  assert.equal(nodule.sliceIndex, 6);
  assert.equal(locOfSop(nodule.sopInstanceUID!), 109);
  assert.equal(nodule.marker.y_pct, 0.494);
  assert.equal(secondaryAnchor(nodule)?.sopInstanceUID, LIDC_ANCHOR_SOPS.aboveNodule);
  assert.equal(locOfSop(secondaryAnchor(nodule)!.sopInstanceUID!), 104);
  const scrolls = nodule.teachingGuide!.beats.flatMap((beat) => beat.actions).filter((action) => action.type === "scroll");
  assert.equal(scrolls[0] && scrolls[0].type === "scroll" && scrolls[0].sliceIndex, 6);
  assert.equal(nodule.teachingGuide!.start.sliceIndex, 0);

  const opening = firstTeacherSlice(repaired.findings, SERIES);
  assert.equal(opening?.sopInstanceUID, LIDC_ANCHOR_SOPS.carina);
  assert.equal(locOfSop(opening!.sopInstanceUID!), 179);
  assert.equal(repaired.findings.find((item) => item.order === 3)?.sopInstanceUID, LIDC_ANCHOR_SOPS.hila);
  assert.equal(locOfSop(LIDC_ANCHOR_SOPS.hila), 189);
});

test("a stored LIDC anchor that is not the known placeholder is left alone", () => {
  const moved = stagingDocument();
  moved.findings[1] = finding({
    id: "f_caselidcno_2",
    order: 2,
    label: "Peripheral nodule survey",
    sliceIndex: 30,
    marker: { x_pct: 0.4, y_pct: 0.4, shape: "circle" },
  });
  const repaired = rebindStaleLidcCase(moved);
  assert.equal(repaired.findings[1]!.sliceIndex, 30);
  assert.equal(repaired.findings[1]!.sopInstanceUID, undefined);
  const recorded = stagingDocument();
  recorded.findings[1] = {
    ...recorded.findings[1]!,
    track: { durationMs: 10, start: { sliceIndex: 49 }, events: [{ t: 0, type: "slice", index: 49 }] },
  };
  assert.equal(rebindStaleLidcCase(recorded).findings[1]!.sliceIndex, 49);
  assert.equal(rebindStaleLidcCase({ ...stagingDocument(), caseId: "case-other" }).findings[1]!.sliceIndex, 49);
});

test("reading the stored staging document rebinds finding 2 without rewriting the file", async () => {
  process.env.MONGODB_URI = "";
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "lidc-stored-"));
  const file = join(process.env.DATA_DIR, "case-lidc-nodule-search.json");
  const stale = stagingDocument();
  writeFileSync(file, JSON.stringify(stale));
  const { getCase } = await import("./cases.ts");
  const loaded = await getCase("case-lidc-nodule-search");
  const nodule = loaded?.findings.find((item) => item.order === 2);
  assert.equal(nodule?.sopInstanceUID, LIDC_ANCHOR_SOPS.nodule);
  assert.equal(nodule?.sliceIndex, 6);
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as { findings: Finding[] };
  assert.equal(onDisk.findings[1]!.sliceIndex, 49);
  assert.equal(onDisk.findings[1]!.sopInstanceUID, undefined);
});
