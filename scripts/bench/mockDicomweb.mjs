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
  };

  const pool = pixelPool(cfg.rows, cfg.columns);
  const frameBytes = cfg.rows * cfg.columns * 2;
  const datasets = Array.from({ length: cfg.slices }, (_, i) => dataset(i, cfg));
  const sopToIndex = new Map(datasets.map((_, i) => [sopFor(i), i]));
  const seriesDoc = Buffer.from(JSON.stringify(datasets));

  const results = [];
  const counters = { frames: 0, instanceMetadata: 0, seriesMetadata: 0, qido: 0, qidoBytes: 0, bytes: 0 };
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

  const server = createServer(async (req, res) => {
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
      res.writeHead(200, {
        "content-type": 'multipart/related; type="application/octet-stream"; boundary=--flowradbench',
        "cache-control": "private, max-age=86400, immutable",
      });
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
      res.writeHead(200, { "content-type": "application/dicom+json" });
      res.end(JSON.stringify([datasets[index]]));
      return;
    }

    if (/^\/studies\/[^/]+\/series\/[^/]+\/metadata$/.test(dicomweb)) {
      // Orthanc assembles the whole document before the first byte.
      await sleep(cfg.metadataBuildMs);
      counters.seriesMetadata += 1;
      counters.bytes += seriesDoc.length;
      res.writeHead(200, {
        "content-type": "application/dicom+json",
        "content-length": String(seriesDoc.length),
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
      res.writeHead(200, { "content-type": "application/dicom+json" });
      res.end(body);
      return;
    }

    res.writeHead(404).end("unhandled dicomweb path");
  });

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
