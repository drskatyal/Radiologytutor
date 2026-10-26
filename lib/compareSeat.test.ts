import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSeatKey, planCompareSeat } from "./compareSeat.ts";
import { secondaryViewerState } from "./findingAnchors.ts";
import { displaySliceNumber } from "./findingDisplayState.ts";
import { stackOpenIndex } from "./stackIndex.ts";
import type { Finding } from "./types.ts";

/** LIDC finding 2 as proved in the live 65-slice study. */
function noduleSurvey(): Finding {
  const marker = { x_pct: 0.2, y_pct: 0.55, shape: "circle" as const };
  return {
    id: "f_caselidcno_2",
    label: "Peripheral nodule survey",
    description: "",
    teachingPoints: [],
    state: " ",
    marker,
    order: 2,
    seriesInstanceUID: "1.2.840.lidc.series",
    studyInstanceUID: "1.2.840.lidc.study",
    sliceIndex: 49,
    windowWidth: 1500,
    windowCenter: -600,
    anchors: [
      {
        studyInstanceUID: "1.2.840.lidc.study",
        seriesInstanceUID: "1.2.840.lidc.series",
        sliceIndex: 49,
        windowWidth: 1500,
        windowCenter: -600,
        marker,
        viewportRole: "primary",
        studyRole: "current",
      },
      {
        studyInstanceUID: "1.2.840.lidc.study",
        seriesInstanceUID: "1.2.840.lidc.series",
        sliceIndex: 47,
        windowWidth: 1500,
        windowCenter: -600,
        zoom: 1,
        pan: [0, 0],
        marker,
        viewportRole: "secondary",
        studyRole: "current",
      },
    ],
  };
}

test("compare open seats the secondary landing, not the 65-slice stack default", () => {
  const finding = noduleSurvey();
  const view = secondaryViewerState(finding);
  assert.ok(view);
  // The failed readout was 33/65, W 399 L -45: stack open + the image window.
  assert.equal(stackOpenIndex(65), 32);
  assert.equal(displaySliceNumber(32), 33);
  assert.equal(view.sliceIndex, 47);
  assert.equal(displaySliceNumber(view.sliceIndex), 48);
  assert.equal(view.windowWidth, 1500);
  assert.equal(view.windowCenter, -600);
  assert.notEqual(view.sliceIndex, stackOpenIndex(65));

  const base = {
    compareOpen: true,
    openGeneration: 1,
    liveGeneration: 1,
    findingId: finding.id,
    view,
  };

  const waiting = planCompareSeat({
    ...base,
    viewportGeneration: 0,
    seatedKey: "",
  });
  assert.equal(waiting.action, "defer");
  if (waiting.action === "defer") {
    assert.equal(waiting.view.sliceIndex, 47);
    assert.equal(waiting.view.windowWidth, 1500);
    assert.equal(waiting.view.windowCenter, -600);
  }

  const firstReady = planCompareSeat({
    ...base,
    viewportGeneration: 1,
    seatedKey: "",
  });
  assert.deepEqual(firstReady, { action: "apply", view });

  const seatedKey = compareSeatKey(1, finding.id);
  const repeat = planCompareSeat({
    ...base,
    viewportGeneration: 1,
    seatedKey,
  });
  assert.deepEqual(repeat, { action: "skip", reason: "already-seated" });

  // Ready was already true, so a boolean edge would not run again. The pane
  // remounted onto the mid-stack default and must be seated a second time.
  const remount = planCompareSeat({
    ...base,
    viewportGeneration: 2,
    seatedKey,
  });
  assert.equal(remount.action, "apply");
  if (remount.action === "apply") {
    assert.equal(remount.view.sliceIndex, 47);
    assert.equal(displaySliceNumber(remount.view.sliceIndex!), 48);
    assert.equal(remount.view.windowWidth, 1500);
    assert.equal(remount.view.windowCenter, -600);
    assert.notEqual(remount.view.sliceIndex, stackOpenIndex(65));
  }
});

test("a closed compare does not apply, and a finding change on the same pane does", () => {
  const finding = noduleSurvey();
  const view = secondaryViewerState(finding);
  assert.ok(view);

  const closed = planCompareSeat({
    compareOpen: false,
    openGeneration: 2,
    liveGeneration: 2,
    viewportGeneration: 3,
    seatedKey: "",
    findingId: finding.id,
    view,
  });
  assert.deepEqual(closed, { action: "skip", reason: "closed" });

  const stale = planCompareSeat({
    compareOpen: true,
    openGeneration: 1,
    liveGeneration: 2,
    viewportGeneration: 3,
    seatedKey: "",
    findingId: finding.id,
    view,
  });
  assert.deepEqual(stale, { action: "skip", reason: "stale" });

  const nextFinding = planCompareSeat({
    compareOpen: true,
    openGeneration: 1,
    liveGeneration: 1,
    viewportGeneration: 1,
    seatedKey: compareSeatKey(1, finding.id),
    findingId: "f_other",
    view,
  });
  assert.equal(nextFinding.action, "apply");

  const noLanding = planCompareSeat({
    compareOpen: true,
    openGeneration: 1,
    liveGeneration: 1,
    viewportGeneration: 1,
    seatedKey: "",
    findingId: finding.id,
    view: null,
  });
  assert.deepEqual(noLanding, { action: "skip", reason: "no-landing" });
});
