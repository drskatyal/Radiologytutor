import { test } from "node:test";
import assert from "node:assert/strict";
import {
  primaryAnchor,
  secondaryAnchor,
  seriesIndexFor,
  wantsCompare,
  withSecondaryAnchor,
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

test("seriesIndexFor returns 0 when the UID is missing", () => {
  const series = [
    { seriesInstanceUID: "a" },
    { seriesInstanceUID: "b" },
  ];
  assert.equal(seriesIndexFor(series, "b"), 1);
  assert.equal(seriesIndexFor(series, "nope"), 0);
  assert.equal(seriesIndexFor(series, undefined), 0);
});
