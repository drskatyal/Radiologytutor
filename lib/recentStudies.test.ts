import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RECENT_STUDIES_MAX,
  openedAgo,
  priorsAmong,
  readRecentStudiesEnabled,
  writeRecentStudiesEnabled,
  RECENT_STUDIES_ENABLED_STORAGE_KEY,
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

test("recent studies: searched as the desktop searches its history (every word, any order, no case or accents)", async () => {
  const { searchRecentStudies } = await import("@flowrad/viewer-core/recentStudies");
  const mk = (key: string, description: string, modalities: string, studyDate?: string) => ({
    key, description, modalities, studyDate, studies: 1, series: 1, images: 10, openedAt: 1,
  });
  const list = [
    mk("a", "CT Thorax Abdomen", "CT", "20240312"),
    mk("b", "IRM Cérébrale", "MR", "20231105"),
    mk("c", "", "CT · PT", "20240101"),
  ];
  const keys = (q: string) => searchRecentStudies(list, q).map((e) => e.key);
  assert.deepEqual(keys(""), ["a", "b", "c"]);
  assert.deepEqual(keys("  "), ["a", "b", "c"]);
  assert.deepEqual(keys("ct"), ["a", "c"]);
  assert.deepEqual(keys("abdomen thorax"), ["a"], "every word, any order");
  assert.deepEqual(keys("cerebrale"), ["b"], "accents ignored");
  assert.deepEqual(keys("2024-03"), ["a"], "ISO date");
  assert.deepEqual(keys("mar 2024"), ["a"], "the date as shown");
  assert.deepEqual(keys("20231105"), ["b"], "DICOM date");
  assert.deepEqual(keys("pt"), ["c"]);
  assert.deepEqual(keys("knee"), []);
});

test("recent studies: a salted patient key, only for one patient's studies", () => {
  const one = (uid: string, patientKey?: string, studyDate = "20240312") => ({ ...study(uid, { studyDate }), patientKey });
  const a = recentStudyEntry([one("1", "pk1")], 0, "salt-a")!;
  assert.match(a.patientKey!, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(a).includes("pk1"), "the key is hashed again, never stored as given");
  assert.equal(recentStudyEntry([one("2", "pk1")], 0, "salt-a")!.patientKey, a.patientKey, "same patient, same browser: same key");
  assert.notEqual(recentStudyEntry([one("1", "pk1")], 0, "salt-b")!.patientKey, a.patientKey, "another browser's salt: another key");
  assert.equal(recentStudyEntry([one("1", "pk1")], 0)!.patientKey, undefined, "no salt, no key");
  assert.equal(recentStudyEntry([one("1")], 0, "salt-a")!.patientKey, undefined, "no patient key in the files");
  assert.equal(recentStudyEntry([one("1", "pk1"), one("2", "pk2")], 0, "salt-a")!.patientKey, undefined, "two patients");
});

test("recent studies: priors are this patient's earlier single studies, newest first", () => {
  const entry = (key: string, patientKey: string | undefined, studyDate: string | undefined, studies = 1): RecentStudy => ({
    key, description: key, modalities: "CT", studyDate, studies, series: 1, images: 1, openedAt: 0, patientKey,
  });
  const current = entry("now", "p", "20250101");
  const list = [
    current,
    entry("older", "p", "20230105"),
    entry("newer", "p", "20240105"),
    entry("sameDay", "p", "20250101"),
    entry("later", "p", "20250601"),
    entry("undated", "p", undefined),
    entry("pair", "p", "20240105", 2),
    entry("other", "q", "20240105"),
    entry("unkeyed", undefined, "20240105"),
  ];
  assert.deepEqual(priorsAmong(list, current).map((e) => e.key), ["newer", "older"]);
  assert.deepEqual(priorsAmong(list, { ...current, patientKey: undefined }), []);
  assert.deepEqual(priorsAmong(list, { ...current, studyDate: undefined }), []);
});

test("recent studies: on by default, off when turned off, and blocked storage keeps them on", () => {
  const data = new Map<string, string>();
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  assert.equal(readRecentStudiesEnabled(store), true);
  writeRecentStudiesEnabled(false, store);
  assert.equal(data.get(RECENT_STUDIES_ENABLED_STORAGE_KEY), "0");
  assert.equal(readRecentStudiesEnabled(store), false);
  writeRecentStudiesEnabled(true, store);
  assert.equal(readRecentStudiesEnabled(store), true);
  assert.equal(readRecentStudiesEnabled(null), true);
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readRecentStudiesEnabled(throwing), true);
  assert.doesNotThrow(() => writeRecentStudiesEnabled(false, throwing));
});
