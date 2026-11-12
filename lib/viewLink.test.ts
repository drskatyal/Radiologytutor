import { test } from "node:test";
import assert from "node:assert/strict";
import { parseViewLink, viewLinkQuery, viewLinkUrl } from "./viewLink";

test("round trip: series, image, window and layout", () => {
  const state = {
    seriesInstanceUID: "1.2.840.113619.2.55.3",
    image: 42,
    ww: 1500,
    wc: -600,
    layout: "1x2" as const,
  };
  const query = viewLinkQuery(state);
  assert.equal(query, "series=1.2.840.113619.2.55.3&im=42&ww=1500&wc=-600&layout=1x2");
  assert.deepEqual(parseViewLink(new URLSearchParams(query)), state);
});

test("malformed params are dropped, never guessed", () => {
  assert.deepEqual(
    parseViewLink(
      new URLSearchParams("series=<script>&im=0&ww=abc&wc=40&layout=9x9")
    ),
    {}
  );
  assert.deepEqual(parseViewLink({ im: "3.5", ww: "400" }), {}, "window needs both halves");
  assert.deepEqual(parseViewLink({ im: "7" }), { image: 7 });
});

test("single layout is the default and stays out of the URL", () => {
  assert.equal(viewLinkQuery({ image: 1, layout: "1x1" }), "im=1");
  assert.equal(viewLinkQuery({}), "");
});

test("view URL keeps mode=view and replaces stale view params", () => {
  const url = viewLinkUrl("https://radlearn.app", "/case/abc?mode=view&im=3&layout=2x2", {
    image: 9,
  });
  assert.equal(url, "https://radlearn.app/case/abc?mode=view&im=9");
});

test("share-token paths work the same way", () => {
  const url = viewLinkUrl("https://radlearn.app", "/s/tok", { image: 2, ww: 80, wc: 40 });
  assert.equal(url, "https://radlearn.app/s/tok?im=2&ww=80&wc=40");
});
