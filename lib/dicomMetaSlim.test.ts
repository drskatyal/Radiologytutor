import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SLIM_TAGS, slimDataset, slimSeriesMetadata } from "./dicomMetaSlim";

const dataset = {
  "00080018": { vr: "UI", Value: ["1.2.3"] },
  "00200032": { vr: "DS", Value: [0, 0, 1] },
  "00280030": { vr: "DS", Value: [0.7, 0.7] },
  "00100010": { vr: "PN", Value: [{ Alphabetic: "DOE^JANE" }] },
  "00091010": { vr: "LO", Value: ["x".repeat(10_000)] },
  "60000010": { vr: "US", Value: [512] },
  "60020010": { vr: "US", Value: [512] },
};

test("keeps what the viewer reads, drops vendor padding and patient name", () => {
  const out = slimDataset(dataset) as Record<string, unknown>;
  assert.ok(out["00080018"] && out["00200032"] && out["00280030"]);
  assert.equal(out["00100010"], undefined, "patient name never needs to reach the browser");
  assert.equal(out["00091010"], undefined, "private tags are dead weight");
  assert.ok(out["60000010"] && out["60020010"], "overlay groups repeat in 6000–601E");
});

test("an 848-instance GCP-sized document shrinks by an order of magnitude", () => {
  const doc = Array.from({ length: 848 }, () => dataset);
  const before = JSON.stringify(doc).length;
  const after = JSON.stringify(slimSeriesMetadata(doc)).length;
  assert.ok(before / after > 10, `${before} → ${after}`);
});

test("every tag the Cornerstone wadors metadata provider reads survives", () => {
  const dir = join(
    process.cwd(),
    "node_modules/@cornerstonejs/dicom-image-loader/dist/esm/imageLoader/wadors/metaData"
  );
  const src = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
  const used = new Set(
    [...src.matchAll(/['"]x?([0-9A-Fa-f]{8})['"]/g)].map((m) => m[1]!.toUpperCase())
  );
  // Deliberately dropped: patient identity the viewer never shows.
  const dropped = new Set(["00080050", "00100010", "00100020", "00100030", "00100032", "00101000", "00101001", "00100021", "00100024", "00101002", "00101005", "00101040", "00101060", "00101090", "00102154", "00102155", "00102160", "00102180", "001021B0", "00104000"]);
  const missing = [...used].filter((t) => !SLIM_TAGS.has(t) && !dropped.has(t) && !t.startsWith("FFFE") && !/^0002000[0-3]$/.test(t) && !/^0002001[2]$/.test(t));
  assert.deepEqual(missing, [], `slim index would drop tags the loader reads: ${missing.join(" ")}`);
});

test("non-array and odd shapes pass through", () => {
  assert.equal(slimSeriesMetadata(null), null);
  assert.deepEqual(slimDataset("x"), "x");
});
