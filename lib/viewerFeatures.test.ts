import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FREE_VIEWER_FEATURES,
  TEACHING_FEATURES,
  VIEWER_FEATURE_NAMES,
  anyViewerFeature,
  viewerFeatures,
} from "./viewerFeatures";

test("the six named groups", () => {
  assert.deepEqual([...VIEWER_FEATURE_NAMES], ["tools", "layouts", "export", "slabs", "localStudies", "keys"]);
});

test("default is the teaching set: everything off (unchanged from readingTools=false)", () => {
  assert.deepEqual(viewerFeatures(), TEACHING_FEATURES);
  assert.deepEqual(viewerFeatures(null), TEACHING_FEATURES);
  assert.equal(anyViewerFeature(viewerFeatures()), false);
});

test("the free viewer has every group (unchanged from readingTools=true)", () => {
  for (const name of VIEWER_FEATURE_NAMES) assert.equal(FREE_VIEWER_FEATURES[name], true, name);
  assert.deepEqual(viewerFeatures(FREE_VIEWER_FEATURES), { ...FREE_VIEWER_FEATURES });
});

test("a partial request turns on only what it names", () => {
  const f = viewerFeatures({ layouts: true });
  assert.deepEqual(f, { ...TEACHING_FEATURES, layouts: true });
  assert.equal(anyViewerFeature(f), true);
});

test("presets cannot be mutated by a caller", () => {
  assert.throws(() => {
    (TEACHING_FEATURES as { tools: boolean }).tools = true;
  });
  const f = viewerFeatures();
  f.tools = true;
  assert.equal(TEACHING_FEATURES.tools, false);
});
