import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseViewportFromUrl,
  parseBaseUrl,
  buildViewerUrl,
  withSlice,
  withWindow,
  withZoomPan,
  PLAYBACK_CHROME,
} from "./pacsbinUrl.ts";

const BOOKMARK =
  "https://pacsbin.com/viewer/abc123?layout=1x1&s:1=SER-9&i:1=IMG-42&ww:1=800&wc:1=400&scale:1=1.75&translation:1=49.6,-35.9&toolbar=true";

test("parseViewportFromUrl extracts all viewport fields as strings/numbers", () => {
  const vp = parseViewportFromUrl(BOOKMARK);
  assert.equal(vp.layout, "1x1");
  assert.equal(vp.s1, "SER-9");
  assert.equal(vp.i1, "IMG-42");
  assert.equal(vp.ww1, 800);
  assert.equal(vp.wc1, 400);
  assert.equal(vp.scale1, 1.75);
  assert.equal(vp.translation1, "49.6,-35.9");
  assert.equal(typeof vp.s1, "string");
  assert.equal(typeof vp.i1, "string");
});

test("parseViewportFromUrl tolerates a bookmark with only series/image/ww/wc", () => {
  const vp = parseViewportFromUrl(
    "https://pacsbin.com/viewer/x?layout=1x1&s:1=A&i:1=B&ww:1=600&wc:1=300"
  );
  assert.equal(vp.s1, "A");
  assert.equal(vp.i1, "B");
  assert.equal(vp.ww1, 600);
  assert.equal(vp.scale1, undefined);
  assert.equal(vp.translation1, undefined);
});

test("parseViewportFromUrl reads a second viewport for compare layouts", () => {
  const vp = parseViewportFromUrl(
    "https://pacsbin.com/viewer/x?layout=2x1&s:1=A&i:1=1&s:2=B&i:2=2&ww:2=500&wc:2=250"
  );
  assert.equal(vp.layout, "2x1");
  assert.equal(vp.s2, "B");
  assert.equal(vp.i2, "2");
  assert.equal(vp.ww2, 500);
});

test("parseBaseUrl strips query string", () => {
  assert.equal(parseBaseUrl(BOOKMARK), "https://pacsbin.com/viewer/abc123");
});

test("buildViewerUrl round-trips through parseViewportFromUrl", () => {
  const vp = parseViewportFromUrl(BOOKMARK);
  const built = buildViewerUrl("https://pacsbin.com/viewer/abc123", vp, PLAYBACK_CHROME);
  const reparsed = parseViewportFromUrl(built);
  assert.deepEqual(reparsed, vp);
});

test("buildViewerUrl keeps ':' and ',' literal (not percent-encoded)", () => {
  const built = buildViewerUrl(
    "https://pacsbin.com/viewer/abc123",
    parseViewportFromUrl(BOOKMARK),
    PLAYBACK_CHROME
  );
  assert.ok(built.includes("s:1=SER-9"), "series param uses literal colon");
  assert.ok(built.includes("translation:1=49.6,-35.9"), "translation uses literal comma");
  assert.ok(!built.includes("%3A"));
  assert.ok(!built.includes("%2C"));
});

test("buildViewerUrl applies playback chrome params", () => {
  const built = buildViewerUrl(
    "https://pacsbin.com/viewer/abc123",
    parseViewportFromUrl(BOOKMARK),
    PLAYBACK_CHROME
  );
  assert.ok(built.includes("toolbar=false"));
  assert.ok(built.includes("seriesList=false"));
  assert.ok(built.includes("header=false"));
});

test("withSlice replaces only the i:1 param", () => {
  const next = withSlice(BOOKMARK, "IMG-43");
  const vp = parseViewportFromUrl(next);
  assert.equal(vp.i1, "IMG-43");
  assert.equal(vp.s1, "SER-9"); // unchanged
  assert.equal(vp.ww1, 800); // unchanged
});

test("withWindow replaces only ww/wc", () => {
  const vp = parseViewportFromUrl(withWindow(BOOKMARK, 1200, 600));
  assert.equal(vp.ww1, 1200);
  assert.equal(vp.wc1, 600);
  assert.equal(vp.i1, "IMG-42");
});

test("withZoomPan replaces only scale/translation", () => {
  const vp = parseViewportFromUrl(withZoomPan(BOOKMARK, 2.5, "10,20"));
  assert.equal(vp.scale1, 2.5);
  assert.equal(vp.translation1, "10,20");
  assert.equal(vp.i1, "IMG-42");
});
