import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderStackDatasets } from "./stackOrder.ts";
import { stackIndexOfSop, withSopAnchoredSlices } from "./viewerLoad.ts";
import { primaryAnchor, secondaryAnchor, secondaryViewerState } from "./findingAnchors.ts";
import { buildLidcSeedCase, scaleTemplateSlices } from "./demoTeachingGuide.ts";
import { LIDC_ANCHOR_SOPS } from "./publicCases/catalog.ts";
import type { Finding } from "./types.ts";

// The seeded LIDC case, loaded against the stack the viewer builds: the
// de-identified series' real geometry and SOPs, in the order the staging
// archive returns them, sorted by ImagePositionPatient (lib/stackOrder). Every
// anchor must land on its anatomy — staging showed finding 1 on the heart
// (index 34), finding 2 and its compare in the upper abdomen (49 / 47) and
// finding 3 at the kidneys (64): template placeholders, not anatomy.

interface FixtureInstance {
  instanceNumber: number;
  position: [number, number, number];
  sliceLocation: number;
  sopInstanceUID: string;
}
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/lidcStackGeometry.json", import.meta.url), "utf8")
) as { orientation: number[]; archiveOrder: FixtureInstance[] };

const seed = JSON.parse(
  readFileSync(new URL("../seed/case-lidc-nodule-search.json", import.meta.url), "utf8")
) as { studyRefs: { studyInstanceUID: string; seriesInstanceUIDs: string[] }[]; findings: Finding[] };
const STUDY = seed.studyRefs[0]!.studyInstanceUID;
const SERIES = seed.studyRefs[0]!.seriesInstanceUIDs[0]!;

/** The viewer's stack: DICOM JSON in archive order → position-sorted imageIds. */
const datasets = fixture.archiveOrder.map((instance) => ({
  "00080018": { vr: "UI", Value: [instance.sopInstanceUID] },
  "00200013": { vr: "IS", Value: [instance.instanceNumber] },
  "00200032": { vr: "DS", Value: instance.position },
  "00200037": { vr: "DS", Value: fixture.orientation },
  "00201041": { vr: "DS", Value: [instance.sliceLocation] },
}));
const stack = orderStackDatasets(datasets);
const imageIds = stack.map(
  (d) => `wadors:/api/dicomweb/studies/${STUDY}/series/${SERIES}/instances/${d["00080018"].Value[0]}/frames/1`
);
const indexOf = (sop: string) => stackIndexOfSop(imageIds, sop);
/** Overlay "Loc" of a stack index (SliceLocation). */
const loc = (index: number) => stack[index]!["00201041"].Value[0];
const byOrder = (order: number) => seed.findings.find((finding) => finding.order === order)!;

test("the LIDC stack sorts head to foot in 5 mm steps, out of a scrambled archive order", () => {
  assert.equal(stack.length, 65);
  assert.notDeepEqual(
    fixture.archiveOrder.map((i) => i.sliceLocation).slice(0, 3),
    [79, 84, 89],
    "the archive does not return anatomical order"
  );
  assert.deepEqual(
    stack.map((_, index) => loc(index)),
    Array.from({ length: 65 }, (_, index) => 79 + 5 * index)
  );
});

test("every seeded finding, anchor and measurement names a SOP that is on its own slice", () => {
  let checked = 0;
  for (const finding of seed.findings) {
    const anchors = [finding, ...(finding.anchors ?? []), ...(finding.measurements ?? [])];
    for (const anchor of anchors) {
      assert.ok(anchor.sopInstanceUID, `${finding.label}: an anchor without a SOP`);
      assert.equal(indexOf(anchor.sopInstanceUID!), anchor.sliceIndex, `${finding.label}: SOP vs index`);
      checked += 1;
    }
  }
  assert.equal(checked, 6);
  // Nothing moves when the session re-anchors by SOP on the sorted stack.
  assert.equal(withSopAnchoredSlices(seed.findings, indexOf), seed.findings);
});

test("finding 1 starts at the carina, Im 21 / Loc 179 — not on the heart (Im 35 / Loc 249)", () => {
  const f = byOrder(1);
  assert.equal(f.sopInstanceUID, LIDC_ANCHOR_SOPS.carina);
  assert.equal(indexOf(f.sopInstanceUID!), 20);
  assert.equal(loc(indexOf(f.sopInstanceUID!)), 179);
  assert.deepEqual([f.marker.x_pct, f.marker.y_pct], [0.54, 0.52]);
});

test("finding 2 lands on the left apical nodule (Im 7 / Loc 109), compare on the slice above", () => {
  const f = byOrder(2);
  assert.equal(f.sopInstanceUID, LIDC_ANCHOR_SOPS.nodule);
  assert.equal(loc(indexOf(f.sopInstanceUID!)), 109);
  assert.equal(primaryAnchor(f).sopInstanceUID, LIDC_ANCHOR_SOPS.nodule);
  assert.equal(f.measurements?.[0]?.sopInstanceUID, LIDC_ANCHOR_SOPS.nodule);
  const sec = secondaryAnchor(f);
  assert.equal(sec?.sopInstanceUID, LIDC_ANCHOR_SOPS.aboveNodule);
  assert.equal(indexOf(sec!.sopInstanceUID!), 5);
  assert.equal(loc(5), 104);
  // The compare pane is driven by that SOP, not by a bare index.
  const view = secondaryViewerState(f);
  assert.equal(view?.sopInstanceUID, LIDC_ANCHOR_SOPS.aboveNodule);
  assert.equal(view?.sliceIndex, 5);
});

test("finding 3 passes through the hila, Im 23 / Loc 189 — not the kidneys (Im 65 / Loc 399)", () => {
  const f = byOrder(3);
  assert.equal(f.sopInstanceUID, LIDC_ANCHOR_SOPS.hila);
  assert.equal(loc(indexOf(f.sopInstanceUID!)), 189);
  assert.deepEqual([f.windowWidth, f.windowCenter], [400, 40]);
});

test("each teaching guide scrolls to its finding's slice from a start above it, inside the chest", () => {
  for (const finding of seed.findings) {
    const guide = finding.teachingGuide!;
    const scrolls = guide.beats.flatMap((beat) => beat.actions).filter((a) => a.type === "scroll");
    assert.ok(scrolls.length > 0, finding.label);
    for (const scroll of scrolls) {
      assert.equal(scroll.type === "scroll" && scroll.sliceIndex, finding.sliceIndex, finding.label);
    }
    assert.ok(guide.start.sliceIndex <= finding.sliceIndex!, finding.label);
    // Every landing is above the diaphragm (the lung bases reach about Loc 320 here).
    assert.ok(loc(finding.sliceIndex!) < 200, `${finding.label} lands at Loc ${loc(finding.sliceIndex!)}`);
  }
});

test("the committed seed is what the catalog builds, and SOP-anchored templates are not rescaled", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(buildLidcSeedCase().findings)), seed.findings);
  // A SOP-anchored template keeps its indices; a fraction-only one still scales.
  const exact = [{ sliceIndex: 20, sopInstanceUID: "a" }, { sliceIndex: 6, sopInstanceUID: "b" }];
  assert.deepEqual(scaleTemplateSlices(exact, 65), exact);
  const fractions = [{ sliceIndex: 4 }, { sliceIndex: 42 }];
  assert.deepEqual(scaleTemplateSlices(fractions, 65).map((f) => f.sliceIndex), [6, 64]);
});
