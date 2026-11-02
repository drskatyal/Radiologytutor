// Synthetic DICOMweb origin for the viewer benchmark (scripts/bench/run.mjs).
//
// Serves ONE uncompressed 16-bit series over WADO-RS/QIDO-RS, shaped exactly
// the way Orthanc shapes it, so the real `lib/progressiveStack.ts` streaming
// loader and the real Cornerstone wadors loader run unmodified:
//
//   QIDO   GET /dicomweb/studies/{st}/series/{se}/instances?limit&offset
//   WADO   GET /dicomweb/studies/{st}/series/{se}/metadata            (streamed)
//   WADO   GET /dicomweb/studies/{st}/series/{se}/instances/{sop}/metadata
//   WADO   GET /dicomweb/studies/{st}/series/{se}/instances/{sop}/frames/1
//
// Every response is delayed by LATENCY_MS to stand in for a round trip, and
// the series metadata document is additionally delayed by METADATA_BUILD_MS
// because Orthanc builds that document in one shot before the first byte.
// Those two knobs are what make the benchmark discriminate between loaders.
//
// No dependencies. Pixel bytes are generated once and re-sliced per frame.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export const STUDY_UID = "1.2.826.0.1.3680043.8.498.10000000000000000000000001";
export const SERIES_UID = "1.2.826.0.1.3680043.8.498.20000000000000000000000001";
export const sopFor = (index) =>
  `1.2.826.0.1.3680043.8.498.3000000000000000000000${String(index).padStart(4, "0")}`;

const str = (vr, value) => ({ vr, Value: [value] });
const nums = (vr, values) => ({ vr, Value: values });

/** One instance's WADO-RS metadata dataset, with every tag the loader reads. */
function dataset(index, cfg) {
  return {
    "00020010": str("UI", "1.2.840.10008.1.2.1"),
    "00080016": str("UI", "1.2.840.10008.5.1.4.1.1.2"),
    "00080018": str("UI", sopFor(index)),
    "00080060": str("CS", cfg.modality),
    "0008103E": str("LO", "BENCH SERIES"),
    "00100010": str("PN", { Alphabetic: "BENCH^SYNTHETIC" }),
    "00100020": str("LO", "BENCH-0001"),
    "0020000D": str("UI", STUDY_UID),
    "0020000E": str("UI", SERIES_UID),
    "00200011": nums("IS", [1]),
    "00200013": nums("IS", [index + 1]),
    "00200032": nums("DS", [-250, -250, index * cfg.sliceThickness]),
    "00200037": nums("DS", [1, 0, 0, 0, 1, 0]),
    "00200052": str("UI", `${STUDY_UID}.1`),
    "00201041": nums("DS", [index * cfg.sliceThickness]),
    "00180050": nums("DS", [cfg.sliceThickness]),
    "00180088": nums("DS", [cfg.sliceThickness]),
    "00280002": nums("US", [1]),
    "00280004": str("CS", "MONOCHROME2"),
    "00280010": nums("US", [cfg.rows]),
    "00280011": nums("US", [cfg.columns]),
    "00280030": nums("DS", [0.9765625, 0.9765625]),
    "00280100": nums("US", [16]),
    "00280101": nums("US", [16]),
    "00280102": nums("US", [15]),
    "00280103": nums("US", [1]),
    "00281050": nums("DS", [40]),
    "00281051": nums("DS", [400]),
    "00281052": nums("DS", [-1024]),
    "00281053": nums("DS", [1]),
  };
}

/** Minimal Part-10 file: meta group + SOP UID + raw OW pixel data (Explicit VR LE). */
function part10(sop, pixels) {
  const el = (group, element, vr, value) => {
    const head = Buffer.alloc(vr === "OW" ? 12 : 8);
    head.writeUInt16LE(group, 0);
    head.writeUInt16LE(element, 2);
    head.write(vr, 4, "latin1");
    if (vr === "OW") head.writeUInt32LE(value.length, 8);
    else head.writeUInt16LE(value.length, 6);
    return Buffer.concat([head, value]);
  };
  const ui = (text) => {
    const b = Buffer.from(text, "latin1");
    return b.length % 2 ? Buffer.concat([b, Buffer.from([0])]) : b;
  };
  const ts = el(0x0002, 0x0010, "UI", ui("1.2.840.10008.1.2.1"));
  const groupLength = Buffer.alloc(4);
  groupLength.writeUInt32LE(ts.length, 0);
  return Buffer.concat([
    Buffer.alloc(128),
    Buffer.from("DICM", "latin1"),
    el(0x0002, 0x0000, "UL", groupLength),
    ts,
    el(0x0008, 0x0018, "UI", ui(sop)),
    el(0x7fe0, 0x0010, "OW", pixels),
  ]);
}

/** One shared noise+gradient plane; each frame reads a rotating window of it. */
function pixelPool(rows, columns) {
  const pixels = rows * columns;
  const pool = new Int16Array(pixels * 2);
  for (let i = 0; i < pool.length; i += 1) {
    const x = i % columns;
    const y = Math.floor(i / columns) % rows;
    const radial = Math.hypot(x - columns / 2, y - rows / 2);
    pool[i] = Math.round(300 * Math.sin(radial / 9) + (i % 211) - 100);
  }
  return pool;
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : undefined);

export async function startMockDicomweb(options = {}) {
  const cfg = {
    slices: Number(options.slices ?? 240),
    rows: Number(options.rows ?? 512),
    columns: Number(options.columns ?? 512),
    latencyMs: Number(options.latencyMs ?? 35),
    metadataBuildMs: Number(options.metadataBuildMs ?? 400),
    sliceThickness: 1.25,
    modality: options.modality ?? "CT",
    // Directory holding a bundle built by scripts/bench/packBundle.ts (the
    // real lib/dicomCdn packer). Unset → the manifest API says "unavailable",
    // exactly like production with conversion off.
    bundleDir: options.bundleDir ?? null,
    // One shared downstream link, in Mbit/s (0 = unlimited). Responses queue
    // FIFO behind each other, the way frames share a learner's connection.
    bandwidthMbps: Number(options.bandwidthMbps ?? 0),
  };
  let linkFreeAt = 0;
  /** Wait until `bytes` have crossed the shared link. */
  const throttle = async (bytes) => {
    if (!(cfg.bandwidthMbps > 0)) return;
    const now = performance.now();
    const start = Math.max(now, linkFreeAt);
    linkFreeAt = start + (bytes * 8) / (cfg.bandwidthMbps * 1000);
    await sleep(linkFreeAt - now);
  };
  let bundleIndex = null;
  if (cfg.bundleDir) {
    bundleIndex = JSON.parse(
      await readFile(join(cfg.bundleDir, "dicom", "v1", STUDY_UID, SERIES_UID, "index.json"), "utf8")
    );
  }

  const pool = pixelPool(cfg.rows, cfg.columns);
  const frameBytes = cfg.rows * cfg.columns * 2;
  const datasets = Array.from({ length: cfg.slices }, (_, i) => dataset(i, cfg));
  const sopToIndex = new Map(datasets.map((_, i) => [sopFor(i), i]));
  const seriesDoc = Buffer.from(JSON.stringify(datasets));

  const results = [];
  const counters = {
    frames: 0,
    instanceMetadata: 0,
    seriesMetadata: 0,
    qido: 0,
    qidoBytes: 0,
    bytes: 0,
    bundleChunks: 0,
    bundleBytes: 0,
  };
  let onResult = () => {};

  const frameBody = (index) => {
    const boundary = "--flowradbench";
    const head = Buffer.from(
      `${boundary}\r\nContent-Type: application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1\r\n\r\n`,
      "latin1"
    );
    const offset = (index * 977) % (pool.length - frameBytes / 2);
    const pixels = Buffer.from(pool.buffer, offset * 2, frameBytes);
    const tail = Buffer.from(`\r\n${boundary}--`, "latin1");
    return Buffer.concat([head, pixels, tail]);
  };

  const handled = async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;


    if (req.method === "POST" && path === "/bench/result") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let payload = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        payload = { error: "unparseable result" };
      }
      results.push(payload);
      res.writeHead(204).end();
      onResult(payload);
      return;
    }

    if (path === "/bench/counters") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(counters));
      return;
    }

    if (path === "/" || path === "/bench/harness.html") {
      const html = await readFile(join(HERE, "harness.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (path === "/bench/harness.js") {
      try {
        const js = await readFile(join(HERE, ".build", "harness.js"));
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(js);
      } catch {
        res.writeHead(500).end("harness bundle missing — run scripts/bench/run.mjs");
      }
      return;
    }

    // Harness bundle sourcemap + the worker/wasm assets esbuild emits next to it.
    // Cornerstone's codec loaders reference their wasm as
    // `new URL("@cornerstonejs/codec-x/wasm", import.meta.url)`. webpack turns
    // that into an asset; esbuild leaves the bare specifier, so the worker asks
    // for /bench/assets/@cornerstonejs/codec-x/wasm. Serve the package's file.
    const codecWasm = /^\/bench\/assets\/@cornerstonejs\/(codec-[a-z0-9-]+)\/(wasm|decodewasm)$/.exec(path);
    if (codecWasm) {
      try {
        const pkgDir = join(HERE, "..", "..", "node_modules", "@cornerstonejs", codecWasm[1]);
        const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8"));
        const target = pkg.exports?.[`./${codecWasm[2]}`];
        const wasm = await readFile(join(pkgDir, target));
        res.writeHead(200, { "content-type": "application/wasm" });
        res.end(wasm);
      } catch {
        res.writeHead(404).end("no such codec");
      }
      return;
    }

    if (path.startsWith("/bench/assets/")) {
      try {
        const asset = await readFile(join(HERE, ".build", path.slice("/bench/assets/".length)));
        const type = path.endsWith(".wasm")
          ? "application/wasm"
          : path.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : "application/octet-stream";
        res.writeHead(200, { "content-type": type });
        res.end(asset);
      } catch {
        res.writeHead(404).end("no such asset");
      }
      return;
    }

    // --- converted-bundle delivery (same shapes as /api/dicom-cdn) ----------
    // Delivered in "proxy" mode: same origin, same per-request latency as a
    // DICOMweb frame, so the comparison is request count + bytes, not a CDN.
    if (path === "/api/dicom-cdn/manifest") {
      await sleep(cfg.latencyMs);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
      res.end(
        JSON.stringify(
          bundleIndex
            ? {
                available: true,
                index: bundleIndex,
                delivery: {
                  mode: "proxy",
                  base: `/cdn/${bundleIndex.version}/`,
                  query: "",
                  expiresAt: Date.now() + 3_600_000,
                },
              }
            : { available: false, reason: "not-converted" }
        )
      );
      return;
    }
    const cdn = /^\/cdn\/([a-z0-9]+)\/((?:[pf]\d{4}\.frb)|meta\.gz)$/.exec(path);
    if (cdn && bundleIndex && cdn[1] === bundleIndex.version) {
      await sleep(cfg.latencyMs);
      try {
        const file = await readFile(
          join(cfg.bundleDir, "dicom", "v1", STUDY_UID, SERIES_UID, cdn[1], cdn[2])
        );
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
        const body = range ? file.subarray(Number(range[1]), Number(range[2]) + 1) : file;
        counters.bundleChunks += 1;
        counters.bundleBytes += body.length;
        counters.bytes += body.length;
        await throttle(body.length);
        res.writeHead(range ? 206 : 200, {
          "content-type": "application/octet-stream",
          "cache-control": "private, max-age=31536000, immutable",
          "content-length": String(body.length),
          ...(range ? { "content-range": `bytes ${range[1]}-${Number(range[1]) + body.length - 1}/${file.length}` } : {}),
        });
        res.end(body);
      } catch {
        res.writeHead(404).end("no such chunk");
      }
      return;
    }

    const dicomweb = path.startsWith("/dicomweb/") ? path.slice("/dicomweb".length) : null;
    if (!dicomweb) {
      res.writeHead(404).end("not found");
      return;
    }

    await sleep(cfg.latencyMs);

    const frame = /^\/studies\/[^/]+\/series\/[^/]+\/instances\/([^/]+)\/frames\/\d+$/.exec(dicomweb);
    if (frame) {
      const index = sopToIndex.get(frame[1]);
      if (index == null) {
        res.writeHead(404).end("no such instance");
        return;
      }
      const body = frameBody(index);
      counters.frames += 1;
      counters.bytes += body.length;
      await throttle(body.length);
      res.writeHead(200, {
        "content-type": 'multipart/related; type="application/octet-stream"; boundary=--flowradbench',
        "cache-control": "private, max-age=86400, stale-while-revalidate=604800, immutable",
        vary: "Accept",
      });
      res.end(body);
      return;
    }

    // Part-10 instance (WADO-RS retrieve instance) — what the lib/dicomCdn
    // packer reads when the app converts a series. Explicit VR LE, raw pixels.
    const instance = /^\/studies\/[^/]+\/series\/[^/]+\/instances\/([^/]+)$/.exec(dicomweb);
    if (instance) {
      const index = sopToIndex.get(instance[1]);
      if (index == null) {
        res.writeHead(404).end("no such instance");
        return;
      }
      const offset = (index * 977) % (pool.length - frameBytes / 2);
      const body = part10(sopFor(index), Buffer.from(pool.buffer, offset * 2, frameBytes));
      counters.bytes += body.length;
      await throttle(body.length);
      res.writeHead(200, { "content-type": "application/dicom" });
      res.end(body);
      return;
    }

    const instanceMeta = /^\/studies\/[^/]+\/series\/[^/]+\/instances\/([^/]+)\/metadata$/.exec(dicomweb);
    if (instanceMeta) {
      const index = sopToIndex.get(instanceMeta[1]);
      if (index == null) {
        res.writeHead(404).end("no such instance");
        return;
      }
      counters.instanceMetadata += 1;
      res.writeHead(200, {
        "content-type": "application/dicom+json",
        // Mirror lib/dicomwebProxy.ts so the browser cache behaves the way it
        // does in front of /api/dicomweb — otherwise the prewarm profile
        // measures a double fetch that production would never make.
        "cache-control": "private, max-age=86400, immutable",
        vary: "Accept",
      });
      res.end(JSON.stringify([datasets[index]]));
      return;
    }

    if (/^\/studies\/[^/]+\/series\/[^/]+\/metadata$/.test(dicomweb)) {
      // Orthanc assembles the whole document before the first byte.
      await sleep(cfg.metadataBuildMs);
      counters.seriesMetadata += 1;
      counters.bytes += seriesDoc.length;
      await throttle(seriesDoc.length);
      res.writeHead(200, {
        "content-type": "application/dicom+json",
        "content-length": String(seriesDoc.length),
        "cache-control": "private, max-age=300, stale-while-revalidate=3600",
        vary: "Accept",
      });
      // Chunked write so the streaming JSON scanner has something to scan.
      const chunk = 64 * 1024;
      for (let at = 0; at < seriesDoc.length; at += chunk) {
        res.write(seriesDoc.subarray(at, Math.min(seriesDoc.length, at + chunk)));
      }
      res.end();
      return;
    }

    if (/^\/studies\/[^/]+\/series\/[^/]+\/instances$/.test(dicomweb)) {
      const limit = Number(url.searchParams.get("limit") ?? cfg.slices);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const rows = [];
      for (let i = offset; i < Math.min(cfg.slices, offset + limit); i += 1) {
        rows.push({ "00080018": str("UI", sopFor(i)) });
      }
      const body = JSON.stringify(rows);
      counters.qido += 1;
      counters.qidoBytes += body.length;
      counters.bytes += body.length;
      res.writeHead(200, {
        "content-type": "application/dicom+json",
        "cache-control": "private, max-age=300, stale-while-revalidate=3600",
      });
      res.end(body);
      return;
    }

    res.writeHead(404).end("unhandled dicomweb path");
  };

  const server = createServer(handled);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    config: cfg,
    counters,
    results,
    resetCounters() {
      counters.frames = 0;
      counters.instanceMetadata = 0;
      counters.seriesMetadata = 0;
      counters.qido = 0;
      counters.qidoBytes = 0;
      counters.bytes = 0;
      counters.bundleChunks = 0;
      counters.bundleBytes = 0;
    },
    waitForResult(timeoutMs = 180_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no benchmark result within ${timeoutMs}ms`)),
          timeoutMs
        );
        onResult = (payload) => {
          clearTimeout(timer);
          onResult = () => {};
          resolve(payload);
        };
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
