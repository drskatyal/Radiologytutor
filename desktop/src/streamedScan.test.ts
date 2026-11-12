import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assembleStreamedHeaders, compareCodePoints } from "./streamedScan";
import { buildStudies } from "./study";
import type { DesktopHeader } from "./types";

function header(fileId: number, fileName: string, over: Partial<DesktopHeader> = {}): DesktopHeader {
  return {
    fileId,
    fileName,
    studyInstanceUID: "1.2.3",
    seriesInstanceUID: "1.2.3.4",
    modality: "CT",
    instanceNumber: fileId + 1,
    baseImageId: `wadouri:f/${fileId}`,
    patientName: undefined,
    ...over,
  };
}

test("compareCodePoints is Rust's str order (UTF-8 bytes), not UTF-16 units", () => {
  const names = ["/a/IM2", "/a/IM10", "/a/Ａ", "/a/\u{1F600}", "/a/B", "/a/b", "/a", "/a/"];
  // UTF-8 byte order of the same strings, the way scan.rs sorts.
  const enc = new TextEncoder();
  const bytes = (s: string) => Array.from(enc.encode(s));
  const byBytes = [...names].sort((x, y) => {
    const a = bytes(x);
    const b = bytes(y);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  });
  assert.deepEqual([...names].sort(compareCodePoints), byBytes);
  // The UTF-16 order differs exactly here: U+FF21 vs an astral code point.
  assert.ok(compareCodePoints("Ａ", "\u{1F600}") < 0);
  assert.ok("Ａ" > "\u{1F600}");
});

test("streamed batches assemble into the list the scan result used to carry", () => {
  // Batches arrive in whatever order the parallel scan produced them.
  const streamed = [header(2, "/s/IM3"), header(0, "/s/IM1"), header(1, "/s/IM2"), header(3, "/t/IM1", { studyInstanceUID: "9" })];
  const patches = [{ fileIds: [0, 2], fields: { patientName: "DOE^JANE", patientId: "42", accessionNumber: null as unknown as string } }];
  const out = assembleStreamedHeaders(streamed, patches);
  assert.deepEqual(
    out.map((h) => h.fileName),
    ["/s/IM1", "/s/IM2", "/s/IM3", "/t/IM1"]
  );
  // Patched in place: the same objects the progressive open already holds.
  assert.equal(out[0].patientName, "DOE^JANE");
  assert.equal(out[2].patientName, "DOE^JANE");
  assert.equal(out[1].patientName, undefined, "not a cache hit: untouched");
  assert.equal(out[0].accessionNumber, null, "a patch field that is null is copied as null, as Rust does");
  assert.ok(streamed.includes(out[0]));
});

test("grouping the assembled list gives the same studies as the full result", () => {
  const full = Array.from({ length: 40 }, (_, i) =>
    header(i, `/s/${String(i).padStart(3, "0")}`, {
      seriesInstanceUID: i % 2 ? "1.2.3.4" : "1.2.3.5",
      imageOrientationPatient: [1, 0, 0, 0, 1, 0],
      imagePositionPatient: [0, 0, (i * 7) % 40],
      patientName: "DOE^JANE",
    })
  );
  // What streamed: the same headers, shuffled, cache hits without the name.
  const streamed = full
    .map((h, i) => ({ ...h, patientName: i % 3 ? undefined : h.patientName }))
    .sort((a, b) => ((a.fileId * 17) % 40) - ((b.fileId * 17) % 40));
  const patches = [{ fileIds: streamed.filter((h) => h.patientName == null).map((h) => h.fileId), fields: { patientName: "DOE^JANE" } }];
  const assembled = assembleStreamedHeaders(streamed, patches);
  assert.deepEqual(assembled, full);
  assert.deepEqual(JSON.stringify(buildStudies(assembled)), JSON.stringify(buildStudies(full)));
});
