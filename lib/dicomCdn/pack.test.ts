import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  TS_EXPLICIT_LE,
  TS_HTJ2K_LOSSLESS_RPCL,
  entryBytes,
  indexKey,
  isUsableIndex,
  unpackContainer,
  versionPrefix,
  type BundleHeader,
} from "./format";
import { NotConvertibleError, buildSeriesBundle, readSeriesIndex, type ArchiveReader } from "./pack";
import { openBundleStore } from "./store";

const STUDY = "1.2.826.0.1.3680043.8.498.1";
const SERIES = "1.2.826.0.1.3680043.8.498.1.2";
const ROWS = 64;
const COLS = 48;

function frame(i: number): Int16Array {
  const px = new Int16Array(ROWS * COLS);
  for (let k = 0; k < px.length; k++) px[k] = ((k * 7 + i * 13) % 2400) - 200;
  return px;
}

function meta(i: number, extra: Record<string, unknown> = {}) {
  return {
    "00080018": { vr: "UI", Value: [`${SERIES}.${i + 1}`] },
    "00200013": { vr: "IS", Value: [i + 1] },
    "00280010": { vr: "US", Value: [ROWS] },
    "00280011": { vr: "US", Value: [COLS] },
    "00280100": { vr: "US", Value: [16] },
    "00280103": { vr: "US", Value: [1] },
    "00280002": { vr: "US", Value: [1] },
    "00281052": { vr: "DS", Value: ["-1024"] },
    "00281053": { vr: "DS", Value: ["1"] },
    "00281050": { vr: "DS", Value: ["40"] },
    "00281051": { vr: "DS", Value: ["400"] },
    "7FE00010": { vr: "OW", BulkDataURI: "http://archive/bulk" },
    ...extra,
  };
}

function archive(count: number, opts: { compressedAt?: number; metaExtra?: Record<string, unknown> } = {}): ArchiveReader {
  // Deliberately NOT InstanceNumber order: the bundle must keep archive order.
  const order = Array.from({ length: count }, (_, i) => (i * 7) % count);
  return {
    async seriesMetadata() {
      return order.map((i) => meta(i, opts.metaExtra));
    },
    async instancePixels(_study, _series, sop) {
      const i = Number(sop.split(".").pop()) - 1;
      if (i === opts.compressedAt) {
        return { transferSyntaxUID: "1.2.840.10008.1.2.4.70", bytes: new Uint8Array([0xff, 0xd8, 1, 2, 3]) };
      }
      return { transferSyntaxUID: TS_EXPLICIT_LE, bytes: new Uint8Array(frame(i).buffer) };
    },
  };
}

function header(body: Uint8Array): { header: BundleHeader; payload: Uint8Array } {
  const { gzHeader, payload } = unpackContainer(body);
  return { header: JSON.parse(gunzipSync(gzHeader).toString("utf8")) as BundleHeader, payload };
}

async function decodeHtj2k(bytes: Uint8Array): Promise<Int16Array> {
  const req = createRequire(join(process.cwd(), "package.json"));
  const mod = await (req("@cornerstonejs/codec-openjph") as () => Promise<any>)();
  const d = new mod.HTJ2KDecoder();
  const log = console.log;
  console.log = () => undefined;
  try {
    d.getEncodedBuffer(bytes.byteLength).set(bytes);
    d.decode();
    const out = d.getDecodedBuffer() as Uint8Array;
    return new Int16Array(out.slice().buffer);
  } finally {
    console.log = log;
    d.delete();
  }
}

test("a series converts to lossless HTJ2K + previews, in archive order, index last", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dicomcdn-"));
  try {
    const store = openBundleStore({ kind: "local", dir });
    const src = archive(40);
    const { index, stats } = await buildSeriesBundle(store, STUDY, SERIES, { archive: src });
    assert.ok(isUsableIndex(index));
    assert.equal(stats.frames, 40);
    const order = (await src.seriesMetadata(STUDY, SERIES)).map((m: any) => m["00080018"].Value[0]);
    assert.deepEqual(index.sops, order, "stack order is the archive's metadata order");
    assert.equal(index.previews.chunks.length, 2); // 32 + 8
    assert.equal(index.frames.transferSyntaxUID, TS_HTJ2K_LOSSLESS_RPCL);
    assert.deepEqual(index.window, { center: 40, width: 400 });
    assert.deepEqual(await readSeriesIndex(store, STUDY, SERIES), index);

    // Every full frame decodes bit-exact.
    const dirKey = versionPrefix(STUDY, SERIES, index.version);
    let seen = 0;
    for (const chunk of index.frames.chunks) {
      const file = (await store.get(`${dirKey}/${chunk.file}`))!;
      const { header: h, payload } = header(file);
      assert.equal(h.kind, "full");
      assert.ok(chunk.count <= 8 && chunk.bytes <= 1024 * 1024 + 64 * 1024, "small chunks");
      // Every index range addresses exactly that frame inside the FILE (Range requests).
      h.entries.forEach((e, k) => {
        const [off, len] = chunk.ranges![k];
        assert.deepEqual([...file.subarray(off, off + len)], [...entryBytes(payload, e)]);
      });
      for (const e of h.entries) {
        assert.equal(e.ts, undefined);
        const i = Number(e.sop.split(".").pop()) - 1;
        assert.equal(index.sops[e.i], e.sop);
        assert.deepEqual([...(await decodeHtj2k(entryBytes(payload, e)))], [...frame(i)]);
        seen++;
      }
    }
    assert.equal(seen, 40);

    // Preview chunks carry JPEG + window + bulk-free metadata for their slices.
    const { header: ph, payload: pp } = header((await store.get(`${dirKey}/p0000.frb`))!);
    assert.equal(ph.entries.length, 32);
    assert.equal(ph.meta!.length, 32);
    assert.ok(!("7FE00010" in (ph.meta![0] as object)), "no bulk data in metadata");
    const e0 = ph.entries[0];
    assert.deepEqual([e0.w, e0.h, e0.lo, e0.hi], [COLS, ROWS, -160, 240]);
    assert.deepEqual([...entryBytes(pp, e0).subarray(0, 2)], [0xff, 0xd8], "JPEG SOI");

    const meta0 = JSON.parse(gunzipSync((await store.get(`${dirKey}/meta.gz`))!).toString("utf8"));
    assert.equal(meta0.length, 40);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rebuild publishes a new version and sweeps the old one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dicomcdn-"));
  try {
    const store = openBundleStore({ kind: "local", dir });
    let t = Date.parse("2026-10-31T00:00:00Z");
    const now = () => new Date((t += 1000));
    const first = await buildSeriesBundle(store, STUDY, SERIES, { archive: archive(5), now });
    const second = await buildSeriesBundle(store, STUDY, SERIES, { archive: archive(5), now });
    assert.notEqual(first.index.version, second.index.version);
    const keys = await store.list(`dicom/v1/${STUDY}/${SERIES}/`);
    assert.ok(keys.includes(indexKey(STUDY, SERIES)));
    assert.ok(keys.every((k) => k === indexKey(STUDY, SERIES) || k.includes(second.index.version)), keys.join("\n"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a frame the archive only has compressed is kept as-is, without a preview", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dicomcdn-"));
  try {
    const store = openBundleStore({ kind: "local", dir });
    const { index } = await buildSeriesBundle(store, STUDY, SERIES, { archive: archive(3, { compressedAt: 1 }) });
    assert.equal(index.fallbackFrames, 1);
    assert.equal(index.previewMissing, 1);
    const { header: h, payload } = header(
      (await store.get(`${versionPrefix(STUDY, SERIES, index.version)}/${index.frames.chunks[0].file}`))!
    );
    const e = h.entries.find((x) => x.sop.endsWith(".2"))!;
    assert.equal(e.ts, "1.2.840.10008.1.2.4.70");
    assert.deepEqual([...entryBytes(payload, e)], [0xff, 0xd8, 1, 2, 3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("multi-frame series stay on DICOMweb and publish nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dicomcdn-"));
  try {
    const store = openBundleStore({ kind: "local", dir });
    await assert.rejects(
      buildSeriesBundle(store, STUDY, SERIES, { archive: archive(2, { metaExtra: { "00280008": { Value: ["20"] } } }) }),
      NotConvertibleError
    );
    assert.equal(await readSeriesIndex(store, STUDY, SERIES), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
