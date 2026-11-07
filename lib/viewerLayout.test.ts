import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NARROW_LAYOUT_MAX_PX,
  defaultPrimaryTool,
  defaultTutorRailOpen,
  dockedImageColumnPx,
  isNarrowLayout,
  requestStageFullscreen,
} from "./viewerLayout.ts";

test("phone and portrait tablet are narrow; 1024 is a desktop stage", () => {
  assert.equal(isNarrowLayout(390), true);
  assert.equal(isNarrowLayout(587), true);
  assert.equal(isNarrowLayout(768), true);
  assert.equal(isNarrowLayout(NARROW_LAYOUT_MAX_PX), true);
  assert.equal(isNarrowLayout(1024), false);
  assert.equal(isNarrowLayout(1280), false);
});

test("the tutor rail starts closed on narrow widths so it cannot cover the image", () => {
  assert.equal(defaultTutorRailOpen(390), false);
  assert.equal(defaultTutorRailOpen(587), false);
  assert.equal(defaultTutorRailOpen(768), false);
  assert.equal(defaultTutorRailOpen(1024), true);
});

test("a docked series rail always leaves the image a real width", () => {
  // Closed strip is 44px. Open rail is min(240, width - 144).
  for (const width of [390, 587, 768, 1024]) {
    const closed = dockedImageColumnPx(width, false);
    const open = dockedImageColumnPx(width, true);
    assert.ok(closed >= width - 44, `${width} closed image ${closed}`);
    assert.ok(open >= 144, `${width} open image ${open}`);
    assert.ok(open < width, `${width} open rail still takes some width`);
  }
  assert.equal(dockedImageColumnPx(390, false), 346);
  assert.equal(dockedImageColumnPx(390, true), 150);
  assert.equal(dockedImageColumnPx(587, true), 347);
});

test("fullscreen uses the native API and falls back when it is rejected", async () => {
  let called = 0;
  const ok = await requestStageFullscreen({
    requestFullscreen: () => {
      called += 1;
      return Promise.resolve();
    },
  });
  assert.equal(ok, true);
  assert.equal(called, 1);

  const webkit = await requestStageFullscreen({
    webkitRequestFullscreen: () => {
      called += 1;
    },
  });
  assert.equal(webkit, true);

  const rejected = await requestStageFullscreen({
    requestFullscreen: () => Promise.reject(new Error("gesture required")),
  });
  assert.equal(rejected, false);
  const missing = await requestStageFullscreen({});
  assert.equal(missing, false);
});

test("read surfaces scroll by default and record still windows", () => {
  assert.equal(defaultPrimaryTool("read"), "StackScroll");
  assert.equal(defaultPrimaryTool("record"), "WindowLevel");
});
