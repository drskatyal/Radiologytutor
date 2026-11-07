import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RECENT_STUDIES_MAX,
  openedAgo,
  recentStudyDetail,
  recentStudyEntry,
  recentStudyTitle,
  studyDateLabel,
  withRecentStudy,
  type RecentStudy,
} from "@flowrad/viewer-core/recentStudies";

const study = (uid: string, over: Partial<{ description: string; studyDate: string; imageCount: number; modalities: string[] }> = {}) => ({
  studyInstanceUID: uid,
  description: over.description,
  studyDate: over.studyDate,
  imageCount: over.imageCount ?? 10,
  series: (over.modalities ?? ["CT"]).map((modality) => ({ modality })),
});

test("recent studies: an entry holds description, modality, date and counts — never the UID", () => {
  const e = recentStudyEntry([study("1.2.840.99.1", { description: "Chest abdomen pelvis", studyDate: "20240312", imageCount: 240, modalities: ["CT", "CT", "SR"] })], 1000)!;
  assert.equal(e.description, "Chest abdomen pelvis");
  assert.equal(e.modalities, "CT · SR");
  assert.equal(e.studyDate, "20240312");
  assert.deepEqual([e.studies, e.series, e.images, e.openedAt], [1, 3, 240, 1000]);
  assert.match(e.key, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(e).includes("1.2.840.99.1"), "no UID in the stored entry");
  // The same studies in any order: the same key.
  const a = recentStudyEntry([study("1.2.3"), study("4.5.6")], 0)!;
  const b = recentStudyEntry([study("4.5.6"), study("1.2.3")], 0)!;
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, recentStudyEntry([study("1.2.3")], 0)!.key);
  assert.equal(recentStudyEntry([], 0), null);
  // A malformed date is dropped, not shown.
  assert.equal(recentStudyEntry([study("x", { studyDate: "2024-03-12" })], 0)!.studyDate, undefined);
});

test("recent studies: newest first, the same study replaced, capped", () => {
  const entry = (key: string, openedAt: number): RecentStudy => ({ key, description: key, modalities: "CT", studies: 1, series: 1, images: 1, openedAt });
  let list: RecentStudy[] = [];
  for (let i = 0; i < RECENT_STUDIES_MAX + 3; i += 1) list = withRecentStudy(list, entry(`k${i}`, i));
  assert.equal(list.length, RECENT_STUDIES_MAX);
  assert.equal(list[0]!.key, `k${RECENT_STUDIES_MAX + 2}`);
  list = withRecentStudy(list, entry("k5", 99));
  assert.equal(list[0]!.key, "k5");
  assert.equal(list.filter((e) => e.key === "k5").length, 1);
});

test("recent studies: labels", () => {
  assert.equal(studyDateLabel("20240312"), "12 Mar 2024");
  assert.equal(studyDateLabel("20241399"), "");
  assert.equal(studyDateLabel(undefined), "");
  const e = recentStudyEntry([study("u", { studyDate: "20240312", imageCount: 240, modalities: ["CT", "CT", "CT"] })], 0)!;
  assert.equal(recentStudyTitle(e), "CT study");
  assert.equal(recentStudyDetail(e), "CT · 12 Mar 2024 · 3 series, 240 images");
  const now = Date.UTC(2026, 10, 7, 12);
  assert.equal(openedAgo(now - 20_000, now), "just now");
  assert.equal(openedAgo(now - 5 * 60_000, now), "5 min ago");
  assert.equal(openedAgo(now - 2 * 3600_000, now), "2 h ago");
  assert.equal(openedAgo(now - 26 * 3600_000, now), "yesterday");
  assert.equal(openedAgo(now - 3 * 86400_000, now), "3 days ago");
});
