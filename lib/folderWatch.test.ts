// Folder watching engine (packages/viewer-core/src/folderWatch.ts), ported
// from FlowRad Viewer with its tests. Synthetic listings and UIDs only.

import assert from "node:assert/strict";
import { test } from "node:test";
import { FolderWatchEngine, fnv1a64, watchRetryDelayMs, type ListedFile, type ProbedFile } from "../packages/viewer-core/src/folderWatch";

const file = (path: string, size: number, mtimeMs: number): ListedFile => ({ path, size, mtimeMs });
const probe = (n: number, study = "1.2.3.4", series = "1.2.3.4.1"): ProbedFile => ({
  sopInstanceUID: `1.2.3.4.1.${n}`,
  studyInstanceUID: study,
  seriesInstanceUID: series,
  modality: "CT",
  studyDescription: "SYNTHETIC CT",
  studyDate: "20260101",
});

test("a file is read only once its size and time held still across two listings and it settled", () => {
  const w = new FolderWatchEngine({ settleMs: 3000 });
  assert.deepEqual(w.observe([file("a.dcm", 100, 0)], 1000).ready, [], "first sight: never read");
  assert.deepEqual(w.observe([file("a.dcm", 200, 1500)], 2000).ready, [], "still growing");
  assert.deepEqual(w.observe([file("a.dcm", 200, 1500)], 3000).ready, [], "unchanged but only 1.5 s old");
  assert.deepEqual(w.observe([file("a.dcm", 200, 1500)], 5000).ready, ["a.dcm"], "stable and settled");
  w.ingest(["a.dcm"], [probe(1)], 5000);
  assert.deepEqual(w.observe([file("a.dcm", 200, 1500)], 6000).ready, [], "read once");
  // Rewritten in place: dropped from its study, read again once stable.
  w.observe([file("a.dcm", 210, 6500)], 7000);
  assert.equal(w.studies().length, 0, "a rewritten file leaves its study until re-read");
  assert.deepEqual(w.observe([file("a.dcm", 210, 6500)], 10_000).ready, ["a.dcm"]);
});

test("dedupe by SOP Instance UID; non-DICOM skipped; studies grouped without identifiers", () => {
  const w = new FolderWatchEngine({ settleMs: 0 });
  const listing = [file("s1/1.dcm", 10, 0), file("s1/2.dcm", 10, 0), file("cache/1-copy.dcm", 10, 0), file("readme.bin", 10, 0)];
  w.observe(listing, 1);
  const ready = w.observe(listing, 2).ready;
  assert.equal(ready.length, 4);
  const probes = ready.map((p) => (p === "readme.bin" ? null : p === "s1/2.dcm" ? probe(2) : probe(1)));
  const r = w.ingest(ready, probes, 2);
  assert.equal(r.added, 2);
  assert.equal(r.duplicates, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.newStudies, 1);
  const [s] = w.studies();
  assert.equal(s.imageCount, 2);
  assert.equal(s.key, fnv1a64("1.2.3.4"));
  assert.ok(!JSON.stringify(s).includes("1.2.3.4"), "no UID in the summary");
  assert.deepEqual(Object.keys(s).sort(), ["date", "description", "firstSeenMs", "imageCount", "key", "modalities", "seriesCount", "updatedMs"]);
  assert.deepEqual(w.filesOf(s.key).length, 2);
});

test("incremental: a study grows as files arrive; removal shrinks it", () => {
  const w = new FolderWatchEngine({ settleMs: 0 });
  const l1 = [file("a/1", 5, 0)];
  w.observe(l1, 0);
  w.ingest(w.observe(l1, 1).ready, [probe(1)], 1);
  const l2 = [...l1, file("a/2", 5, 0), file("b/1", 5, 0)];
  w.observe(l2, 2);
  const ready = w.observe(l2, 3).ready;
  const r = w.ingest(ready, [probe(2), probe(9, "9.9.9")], 3);
  assert.equal(r.newStudies, 1);
  assert.equal(r.changed.length, 2);
  assert.equal(w.studies().find((s) => s.key === fnv1a64("1.2.3.4"))!.imageCount, 2);
  w.observe([file("a/1", 5, 0)], 4);
  assert.equal(w.studies().length, 1, "the study whose files vanished is gone");
});

test("bounded: tracked files, probes per poll, studies kept", () => {
  const w = new FolderWatchEngine({ settleMs: 0, maxTracked: 50, maxProbePerPoll: 10, maxStudies: 3 });
  const listing = Array.from({ length: 80 }, (_, i) => file(`f${i}`, 1, 0));
  assert.equal(w.observe(listing, 0).truncated, true);
  assert.equal(w.trackedCount, 50);
  const first = w.observe(listing, 1);
  assert.equal(first.ready.length, 10, "back-pressure: ten per poll");
  w.ingest(first.ready, first.ready.map((_, i) => probe(i, `study.${i}`)), 1);
  assert.equal(w.studies().length, 3, "oldest studies evicted");
  const next = w.observe(listing, 2);
  assert.equal(next.ready.length, 10);
  assert.ok(next.ready.every((p) => !first.ready.includes(p)), "read files are not read again");
});

test("retry backoff is capped", () => {
  assert.equal(watchRetryDelayMs(0), 5000);
  assert.equal(watchRetryDelayMs(2), 20_000);
  assert.equal(watchRetryDelayMs(50), 60_000);
});

