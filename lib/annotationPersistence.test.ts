// Local annotation persistence (packages/viewer-core/src/annotationPersistence.ts),
// ported from FlowRad Viewer with its tests. Synthetic UIDs only.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  annotationRecord,
  fnv1a64,
  imageStorageKey,
  parseAnnotationRecord,
  resolveImageIndex,
  seriesStorageKey,
  textBoxLines,
} from "../packages/viewer-core/src/annotationPersistence";

test("fnv1a64: stable 16-hex keys (no UID text stored)", () => {
  assert.equal(fnv1a64(""), "cbf29ce484222325");
  assert.equal(fnv1a64("a"), "af63dc4c8601ec8c");
  assert.match(fnv1a64("1.2.840.99999.1"), /^[0-9a-f]{16}$/);
  assert.notEqual(fnv1a64("1.2.3"), fnv1a64("1.2.4"));
});

test("annotation records: keys are hashes; malformed or foreign records are dropped", () => {
  const key = seriesStorageKey("1.2.840.99999.1");
  assert.match(key, /^[0-9a-f]{16}$/);
  const rec = annotationRecord(key, [
    { id: "na-1", tool: "TextBox", imageIndex: 3, points: [[10, 20]], label: "x".repeat(900), imageKey: imageStorageKey("1.2.3", 0) },
    { id: "na-2", tool: "Length", imageIndex: 0, points: [[0, 0], [5, 5]] },
  ]);
  const back = parseAnnotationRecord(JSON.parse(JSON.stringify(rec)), key);
  assert.equal(back.length, 2);
  assert.equal(back[0].label!.length, 500, "text capped");
  assert.deepEqual(parseAnnotationRecord(rec, seriesStorageKey("other")), [], "another series' record is ignored");
  const bad = { ...rec, items: [{ id: "x", tool: "Length", imageIndex: -1, points: [[0, 0]] }, { id: "y", tool: "TextBox", imageIndex: 0, points: [["a", 1]] }] };
  assert.deepEqual(parseAnnotationRecord(bad, key), []);
  assert.deepEqual(parseAnnotationRecord("nonsense", key), []);
});

test("stored annotations re-attach by image key when the order changes", () => {
  const keys = ["k0", "k1", "k2"].map((k) => imageStorageKey(k));
  assert.equal(resolveImageIndex({ id: "a", tool: "TextBox", imageIndex: 0, points: [[0, 0]], imageKey: keys[2] }, keys), 2);
  assert.equal(resolveImageIndex({ id: "a", tool: "TextBox", imageIndex: 0, points: [[0, 0]], imageKey: imageStorageKey("gone") }, keys), null);
  assert.equal(resolveImageIndex({ id: "a", tool: "TextBox", imageIndex: 1, points: [[0, 0]] }, keys), 1);
  assert.equal(resolveImageIndex({ id: "a", tool: "TextBox", imageIndex: 7, points: [[0, 0]] }, keys), null);
});

test("text boxes wrap and cap their lines", () => {
  assert.deepEqual(textBoxLines("short"), ["short"]);
  assert.deepEqual(textBoxLines("one two three", 7), ["one two", "three"]);
  assert.equal(textBoxLines("a\n".repeat(40)).length, 12);
});
