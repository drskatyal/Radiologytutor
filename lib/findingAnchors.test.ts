import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comparePaneSeriesIndex,
  primaryAnchor,
  secondaryAnchor,
  secondaryViewerState,
  seriesIndexFor,
  wantsCompare,
  withPrimaryAnchor,
  withSecondaryAnchor,
  withoutSecondaryAnchor,
} from "./findingAnchors.ts";
import type { Finding } from "./types.ts";

function finding(partial: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    label: "Caudate head",
    description: "",
    teachingPoints: ["Compare contralateral"],
    state: " ",
    marker: { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
    order: 0,
    seriesInstanceUID: "ser-a",
    sliceIndex: 3,
    ...partial,
  };
}

test("primaryAnchor falls back to finding fields when anchors are absent", () => {
  const a = primaryAnchor(finding());
  assert.equal(a.seriesInstanceUID, "ser-a");
  assert.equal(a.sliceIndex, 3);
  assert.equal(a.marker.x_pct, 0.42);
  assert.equal(a.viewportRole, "primary");
});

test("secondaryAnchor is null without a compare landing", () => {
  assert.equal(secondaryAnchor(finding()), null);
  assert.equal(wantsCompare(finding()), false);
});

test("wantsCompare is true for a second series landing", () => {
  const f = finding({
    anchors: [
      {
        seriesInstanceUID: "ser-a",
        sliceIndex: 3,
        marker: { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
        viewportRole: "primary",
      },
      {
        seriesInstanceUID: "ser-b",
        sliceIndex: 1,
        marker: { x_pct: 0.5, y_pct: 0.5, shape: "circle" },
        viewportRole: "secondary",
      },
    ],
  });
  assert.equal(wantsCompare(f), true);
  assert.equal(secondaryAnchor(f)?.seriesInstanceUID, "ser-b");
});

test("withSecondaryAnchor keeps primary and tags the new landing", () => {
  const next = withSecondaryAnchor(finding(), {
    seriesInstanceUID: "ser-b",
    sliceIndex: 2,
    marker: { x_pct: 0.3, y_pct: 0.4, shape: "circle" },
  });
  assert.equal(next.length, 2);
  assert.equal(next[0].viewportRole, "primary");
  assert.equal(next[1].viewportRole, "secondary");
  assert.equal(next[1].seriesInstanceUID, "ser-b");
});

test("wantsCompare is true for a same-series different-slice landing", () => {
  const f = finding({
    anchors: [
      {
        seriesInstanceUID: "ser-a",
        sliceIndex: 3,
        marker: { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
        viewportRole: "primary",
      },
      {
        seriesInstanceUID: "ser-a",
        sliceIndex: 9,
        marker: { x_pct: 0.5, y_pct: 0.5, shape: "circle" },
        viewportRole: "secondary",
      },
    ],
  });
  assert.equal(wantsCompare(f), true);
});

test("primaryAnchor ignores a secondary landing and keeps the finding fields", () => {
  const a = primaryAnchor(
    finding({
      anchors: [
        {
          seriesInstanceUID: "ser-b",
          sliceIndex: 9,
          marker: { x_pct: 0.1, y_pct: 0.2, shape: "circle" },
          viewportRole: "secondary",
        },
      ],
    })
  );
  assert.equal(a.seriesInstanceUID, "ser-a");
  assert.equal(a.sliceIndex, 3);
  assert.equal(a.viewportRole, "primary");
});

test("wantsCompare is false when the secondary landing clones the primary", () => {
  const f = finding({
    windowWidth: 1500,
    windowCenter: -600,
    anchors: [
      {
        seriesInstanceUID: "ser-a",
        sliceIndex: 3,
        windowWidth: 1500,
        windowCenter: -600,
        marker: { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
        viewportRole: "primary",
      },
      {
        seriesInstanceUID: "ser-a",
        sliceIndex: 3,
        windowWidth: 1500,
        windowCenter: -600,
        zoom: 1,
        marker: { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
        viewportRole: "secondary",
      },
    ],
  });
  assert.equal(wantsCompare(f), false);
  assert.equal(secondaryViewerState(f), null);
});

test("wantsCompare is true for the same slice in a different window", () => {
  const f = finding({
    windowWidth: 1500,
    windowCenter: -600,
    anchors: [
      {
        seriesInstanceUID: "ser-a",
        sliceIndex: 3,
        windowWidth: 1500,
        windowCenter: -600,
        marker: { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
        viewportRole: "primary",
      },
      {
        seriesInstanceUID: "ser-a",
        sliceIndex: 3,
        windowWidth: 400,
        windowCenter: 40,
        marker: { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
        viewportRole: "secondary",
      },
    ],
  });
  assert.equal(wantsCompare(f), true);
  const view = secondaryViewerState(f);
  assert.equal(view?.sliceIndex, 3);
  assert.equal(view?.windowWidth, 400);
  assert.equal(view?.windowCenter, 40);
});

test("wantsCompare is true when only the camera differs", () => {
  const f = finding({
    anchors: [
      {
        seriesInstanceUID: "ser-a",
        sliceIndex: 3,
        zoom: 1,
        pan: [0, 0],
        marker: { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
        viewportRole: "primary",
      },
      {
        seriesInstanceUID: "ser-a",
        sliceIndex: 3,
        zoom: 2.2,
        pan: [12, -4],
        marker: { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
        viewportRole: "secondary",
      },
    ],
  });
  assert.equal(wantsCompare(f), true);
  assert.deepEqual(secondaryViewerState(f), {
    sliceIndex: 3,
    zoom: 2.2,
    pan: [12, -4],
  });
});

test("compare pane uses the secondary series and does not invent one", () => {
  const series = [
    { seriesInstanceUID: "ser-a" },
    { seriesInstanceUID: "ser-b" },
  ];
  assert.equal(comparePaneSeriesIndex(series, finding(), "ser-a"), 1);
  assert.equal(
    comparePaneSeriesIndex([{ seriesInstanceUID: "ser-a" }], finding(), "ser-a"),
    0
  );
  const sameSeries = finding({
    anchors: [
      {
        seriesInstanceUID: "ser-a",
        sliceIndex: 3,
        marker: { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
        viewportRole: "primary",
      },
      {
        seriesInstanceUID: "ser-a",
        sliceIndex: 9,
        windowWidth: 1500,
        windowCenter: -600,
        marker: { x_pct: 0.5, y_pct: 0.5, shape: "circle" },
        viewportRole: "secondary",
      },
    ],
  });
  assert.equal(
    comparePaneSeriesIndex([{ seriesInstanceUID: "ser-a" }], sameSeries, "ser-a"),
    0
  );
  assert.equal(secondaryViewerState(sameSeries)?.sliceIndex, 9);
  assert.notEqual(secondaryViewerState(sameSeries)?.sliceIndex, sameSeries.sliceIndex);
});

test("withPrimaryAnchor keeps a pinned compare landing", () => {
  const f = finding({
    anchors: withSecondaryAnchor(finding(), {
      seriesInstanceUID: "ser-a",
      sliceIndex: 9,
      marker: { x_pct: 0.2, y_pct: 0.3, shape: "circle" },
    }),
  });
  const next = withPrimaryAnchor(f, {
    seriesInstanceUID: "ser-a",
    sliceIndex: 4,
    marker: { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
  });
  assert.equal(next[0].sliceIndex, 4);
  assert.equal(next[1].viewportRole, "secondary");
  assert.equal(next[1].sliceIndex, 9);
  assert.equal(withoutSecondaryAnchor(f).length, 1);
  assert.equal(withoutSecondaryAnchor(f)[0].viewportRole, "primary");
});

test("seriesIndexFor returns 0 when the UID is missing", () => {
  const series = [
    { seriesInstanceUID: "a" },
    { seriesInstanceUID: "b" },
  ];
  assert.equal(seriesIndexFor(series, "b"), 1);
  assert.equal(seriesIndexFor(series, "nope"), 0);
  assert.equal(seriesIndexFor(series, undefined), 0);
});
