#!/usr/bin/env node
// Phantom Orthanc — a stand-in archive for UI smoke runs and screenshots.
//
//   node scripts/bench/phantomOrthanc.mjs --port 8042 --study <StudyInstanceUID> --series <SeriesUID>
//   ORTHANC_URL=http://127.0.0.1:8042 npx next start -p 3123
//
// Production-shaped knobs (scripts/bench/viewerLoad.mjs uses them):
//   --slices 848     axial thin-series length            (default 96)
//   --matrix 512     rows = columns                      (default 256)
//   --latency 620    ms added to every DICOMweb request  (default 0) — the
//                    Cloud Healthcare per-frame time measured in production
//   --meta-pad 10000 extra bytes per instance in metadata (default 0) — GCP's
//                    series metadata for an 848-slice CT is ~9.5 MB
//   GET  /phantom/stats   per-route request counts + frames served; POST resets
//
// Frames honour Accept like a transcoding archive: `transfer-syntax=*` or
// explicit VR LE → raw; `type="image/jls"` / transfer-syntax 1.2.840.10008.1.2.4.80
// → lossless JPEG-LS (CharLS); anything else → 406.
//
// Answers the slice of the Orthanc REST API that lib/orthanc.ts uses to list a
// case's series (POST /tools/find, GET /studies|/series|/instances/{id}) and
// the DICOMweb paths the viewer reads through /api/dicomweb (QIDO instances,
// series + instance metadata, uncompressed frames, /rendered thumbnails).
//
// The pixels are a synthetic chest CT phantom computed from a closed-form
// function of patient-space millimetres: body wall, subcutaneous fat, two
// lungs with vessels, heart, contrast-filled aorta, spine, ribs, the table,
// and one 7 mm nodule in the right lower lobe. Three series share the volume:
// thin axial, thick axial, and a coronal reformat — enough to exercise the
// series rail, hanging layouts, orientation letters and MPR.
//
// It is NOT a conformance test of anything; it exists so the real UI can be
// driven and photographed without a real archive or real patient data. No
// patient-module tags are emitted at all.

import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);

const PORT = Number(args.get("port") ?? 8042);
const STUDY_UID = args.get("study") ?? "1.2.826.0.1.3680043.8.498.90000000000000000000000001";
const AXIAL_UID = args.get("series") ?? "1.2.826.0.1.3680043.8.498.90000000000000000000000002";
const ROOT = "1.2.826.0.1.3680043.8.498.9";

const N = Number(args.get("matrix") ?? 256);
const SLICES = Number(args.get("slices") ?? 96);
const LATENCY_MS = Number(args.get("latency") ?? 0);
const META_PAD = Number(args.get("meta-pad") ?? 0);
const JLS_TS = "1.2.840.10008.1.2.4.80";
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);

// Request accounting for the load benchmark.
const stats = { started: Date.now(), byRoute: {}, frames: new Set(), frameRequests: 0, jlsFrames: 0, bytesOut: 0, firstFrameAt: 0, lastNewFrameAt: 0 };
function count(route) {
  stats.byRoute[route] = (stats.byRoute[route] ?? 0) + 1;
}

// CharLS (the decoder Cornerstone ships) also encodes. Loaded on first use.
let charls = null;
async function jlsEncode(raw) {
  if (!charls) {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const factory = require(new URL("../../node_modules/@cornerstonejs/codec-charls/dist/charlswasm.js", import.meta.url).pathname);
    charls = await factory();
  }
  const enc = new charls.JpegLSEncoder();
  const buf = enc.getDecodedBuffer({ width: N, height: N, bitsPerSample: 16, componentCount: 1 });
  buf.set(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  enc.setNearLossless(0);
  enc.encode();
  const out = Buffer.from(enc.getEncodedBuffer());
  enc.delete?.();
  return out;
}
const jlsCache = new Map();
const FOV = 360; // mm
const PX = FOV / N;
const Z_TOP = 250; // mm, apex end

const SERIES = [
  {
    id: "ps-axial-thin",
    uid: AXIAL_UID,
    number: 2,
    description: "CT CHEST 2.5 LUNG",
    plane: "axial",
    count: SLICES,
    thickness: 2.5,
    center: -600,
    width: 1500,
  },
  {
    id: "ps-axial-thick",
    uid: `${ROOT}.3`,
    number: 3,
    description: "CT CHEST 5.0 SOFT",
    plane: "axial",
    count: 48,
    thickness: 5,
    center: 40,
    width: 400,
  },
  {
    id: "ps-coronal",
    uid: `${ROOT}.4`,
    number: 4,
    description: "COR MPR 3.0",
    plane: "coronal",
    count: 64,
    thickness: 3,
    center: 40,
    width: 400,
  },
];

const sop = (s, i) => `${s.uid}.${i + 1}`;
const studyId = "phantom-study";

// --- Phantom -------------------------------------------------------------

function inEllipse(x, y, cx, cy, a, b) {
  const dx = (x - cx) / a;
  const dy = (y - cy) / b;
  return dx * dx + dy * dy;
}

// Deterministic speckle so frames are stable across requests.
function noise(x, y, z) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return (n - Math.floor(n) - 0.5) * 24;
}

/** HU at a patient-space point (LPS mm; z up = head). */
function hu(x, y, z) {
  const zf = Math.min(1, Math.max(0, z / Z_TOP)); // 0 base → 1 apex
  // Table below the patient.
  if (y > 150 && y < 160 && Math.abs(x) < 170) return 300;
  const body = inEllipse(x, y, 0, 5, 165 - 18 * zf, 118 - 10 * zf);
  if (body > 1) return -1000 + noise(x, y, z) * 0.2;
  const muscle = inEllipse(x, y, 0, 5, 150 - 18 * zf, 104 - 10 * zf);
  if (muscle > 1) return -95 + noise(x, y, z);

  // Spine and ribs.
  const spine = Math.hypot(x, y - 92);
  if (spine < 19) return spine > 15 ? 950 : 380 + noise(x, y, z);
  if (Math.hypot(x, y - 120) < 9) return 700;
  const rib = inEllipse(x, y, 0, 8, 138 - 18 * zf, 93 - 10 * zf);
  // Ribs: short arcs whose angle walks with z, the way an axial cut meets them.
  const angle = Math.atan2(y - 8, x);
  const ribArc = Math.sin(angle * 9 + z / 7);
  if (rib > 0.94 && rib < 1.0 && ribArc > 0.55) return 850;

  // Lungs: shrink toward the apex and the bases.
  const lungScale = Math.sin(Math.PI * Math.min(1, Math.max(0, (z + 25) / (Z_TOP + 15))));
  if (lungScale > 0.08) {
    const a = 58 * lungScale + 6;
    const b = 76 * lungScale + 6;
    for (const side of [-1, 1]) {
      const cx = side * 70;
      const d = inEllipse(x, y, cx, -4, a, b);
      if (d <= 1) {
        // Heart notch on the patient's left (+x).
        if (side === 1 && z < 150 && inEllipse(x, y, 30, 22, 52, 46) < 1) break;
        // Nodule: right lower lobe (patient right = −x).
        if (side === -1 && Math.hypot(x + 82, y + 12, z - 92) < 3.6) return 25 + noise(x, y, z);
        // Vessels branch from the hilum: brighter dots near the center.
        // Vessels: thin tubes radiating from the hilum, tapering outward.
        const hx = x - cx * 0.45;
        const r = Math.hypot(hx, y);
        const theta = Math.atan2(y, hx);
        const branch = Math.abs(Math.sin(theta * 7 + z * 0.045 + side));
        const width = 0.07 * Math.max(0.15, 1 - r / 85);
        if (r > 6 && branch < width) return 30 + noise(x, y, z);
        return -860 + noise(x, y, z) * 1.5;
      }
    }
  }
  // Heart, aorta, pulmonary trunk.
  if (z < 150 && inEllipse(x, y, 30, 22, 52, 46) < 1) {
    return inEllipse(x, y, 30, 22, 30, 26) < 1 ? 160 + noise(x, y, z) : 45 + noise(x, y, z);
  }
  if (Math.hypot(x + 18, y - 64) < 14) return 230 + noise(x, y, z); // descending aorta
  if (z > 140 && z < 175 && Math.hypot(x + 10, y + 30) < 16) return 230 + noise(x, y, z); // arch
  if (Math.hypot(x - 2, y + 18) < 9 && z > 100) return 60; // trachea wall
  return 42 + noise(x, y, z);
}

/** Patient position + direction cosines for one slice of a series. */
function geometry(s, index) {
  if (s.plane === "coronal") {
    // Rows run head → feet, columns patient right → left. Slices go A → P.
    const y = -110 + index * (220 / (s.count - 1));
    return {
      ipp: [-FOV / 2, y, Z_TOP],
      iop: [1, 0, 0, 0, 0, -1],
      at: (r, c) => [-FOV / 2 + c * PX, y, Z_TOP - r * PX * (Z_TOP / FOV) * 1.0],
      rowSpacing: PX * (Z_TOP / FOV),
    };
  }
  // Instance 1 is the apex end so the stack scrolls head → feet.
  const z = Z_TOP - index * ((Z_TOP - 10) / (s.count - 1));
  return {
    ipp: [-FOV / 2, -FOV / 2, z],
    iop: [1, 0, 0, 0, 1, 0],
    at: (r, c) => [-FOV / 2 + c * PX, -FOV / 2 + r * PX, z],
    rowSpacing: PX,
  };
}

const frameCache = new Map();
function frame(s, index) {
  const key = `${s.id}:${index}`;
  const hit = frameCache.get(key);
  if (hit) return hit;
  const g = geometry(s, index);
  const out = new Int16Array(N * N);
  for (let r = 0; r < N; r += 1) {
    for (let c = 0; c < N; c += 1) {
      const [x, y, z] = g.at(r, c);
      // Thick slices average three samples through the slab.
      let v = 0;
      const taps = s.thickness >= 5 ? 3 : 1;
      for (let t = 0; t < taps; t += 1) {
        const dz = taps === 1 ? 0 : (t - 1) * (s.thickness / 3);
        v += s.plane === "coronal" ? hu(x, y + dz, z) : hu(x, y, z + dz);
      }
      out[r * N + c] = Math.round(v / taps);
    }
  }
  const buf = Buffer.from(out.buffer);
  frameCache.set(key, buf);
  return buf;
}

// --- Metadata ------------------------------------------------------------

const str = (vr, value) => ({ vr, Value: [value] });
const nums = (vr, values) => ({ vr, Value: values });

function dataset(s, i) {
  const g = geometry(s, i);
  return {
    "00020010": str("UI", "1.2.840.10008.1.2.1"),
    "00080016": str("UI", "1.2.840.10008.5.1.4.1.1.2"),
    "00080018": str("UI", sop(s, i)),
    "00080060": str("CS", "CT"),
    "0008103E": str("LO", s.description),
    "0020000D": str("UI", STUDY_UID),
    "0020000E": str("UI", s.uid),
    "00200011": nums("IS", [s.number]),
    "00200013": nums("IS", [i + 1]),
    "00200032": nums("DS", g.ipp),
    "00200037": nums("DS", g.iop),
    "00200052": str("UI", `${STUDY_UID}.1`),
    "00201041": nums("DS", [s.plane === "coronal" ? g.ipp[1] : g.ipp[2]]),
    "00180050": nums("DS", [s.thickness]),
    "00280002": nums("US", [1]),
    "00280004": str("CS", "MONOCHROME2"),
    "00280010": nums("US", [N]),
    "00280011": nums("US", [N]),
    "00280030": nums("DS", [g.rowSpacing, PX]),
    "00280100": nums("US", [16]),
    "00280101": nums("US", [16]),
    "00280102": nums("US", [15]),
    "00280103": nums("US", [1]),
    "00281050": nums("DS", [s.center]),
    "00281051": nums("DS", [s.width]),
    "00281052": nums("DS", [0]),
    "00281053": nums("DS", [1]),
    ...(META_PAD > 0 ? { "00091010": str("LO", "x".repeat(META_PAD)) } : {}),
  };
}

function qidoInstance(s, i) {
  return {
    "00080018": str("UI", sop(s, i)),
    "0020000D": str("UI", STUDY_UID),
    "0020000E": str("UI", s.uid),
    "00200013": nums("IS", [i + 1]),
  };
}

// --- PNG (thumbnails for the series rail) ----------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(s, index, size = 96) {
  const pixels = new Int16Array(frame(s, index).buffer.slice(0));
  const raw = Buffer.alloc((size + 1) * size);
  const lo = s.center - s.width / 2;
  for (let y = 0; y < size; y += 1) {
    raw[y * (size + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const v = pixels[Math.floor((y * N) / size) * N + Math.floor((x * N) / size)];
      raw[y * (size + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(((v - lo) / s.width) * 255)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Server --------------------------------------------------------------

const json = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/dicom+json" });
  res.end(JSON.stringify(body));
};
const seriesByUid = (uid) => SERIES.find((s) => s.uid === uid);
const seriesById = (id) => SERIES.find((s) => s.id === id);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  if (path === "/phantom/stats") {
    if (req.method === "POST") {
      Object.assign(stats, { started: Date.now(), byRoute: {}, frames: new Set(), frameRequests: 0, jlsFrames: 0, bytesOut: 0, firstFrameAt: 0, lastNewFrameAt: 0 });
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...stats, frames: stats.frames.size }));
    return;
  }
  try {
    if (req.method === "POST" && path === "/tools/find") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (body.Level === "Study") {
        return json(res, body.Query?.StudyInstanceUID === STUDY_UID ? [studyId] : []);
      }
      if (body.Level === "Series") {
        const s = seriesByUid(body.Query?.SeriesInstanceUID);
        return json(res, s ? [s.id] : []);
      }
      return json(res, []);
    }
    if (path === `/studies/${studyId}`) {
      return json(res, {
        ID: studyId,
        Series: SERIES.map((s) => s.id),
        MainDicomTags: { StudyInstanceUID: STUDY_UID },
      });
    }
    let m = /^\/series\/([^/]+)$/.exec(path);
    if (m) {
      const s = seriesById(m[1]);
      if (!s) return json(res, { error: "no series" }, 404);
      return json(res, {
        ID: s.id,
        ParentStudy: studyId,
        Instances: Array.from({ length: s.count }, (_, i) => `${s.id}-${i}`),
        MainDicomTags: {
          SeriesInstanceUID: s.uid,
          Modality: "CT",
          SeriesDescription: s.description,
          SeriesNumber: String(s.number),
        },
      });
    }
    m = /^\/instances\/(ps-[a-z-]+)-(\d+)$/.exec(path);
    if (m) {
      const s = seriesById(m[1]);
      const i = Number(m[2]);
      if (!s) return json(res, { error: "no instance" }, 404);
      return json(res, {
        ID: `${s.id}-${i}`,
        ParentSeries: s.id,
        MainDicomTags: { SOPInstanceUID: sop(s, i), InstanceNumber: String(i + 1) },
      });
    }

    const dw = path.startsWith("/dicom-web/") ? path.slice("/dicom-web".length) : null;
    if (!dw) return json(res, { error: "not found" }, 404);
    await sleep(LATENCY_MS);

    m = /^\/studies\/[^/]+\/series$/.exec(dw);
    if (m) {
      return json(
        res,
        SERIES.map((s) => ({
          "0020000E": str("UI", s.uid),
          "00080060": str("CS", "CT"),
          "0008103E": str("LO", s.description),
          "00200011": nums("IS", [s.number]),
          "00201209": nums("IS", [s.count]),
        }))
      );
    }
    m = /^\/studies\/[^/]+\/series\/([^/]+)\/instances$/.exec(dw);
    if (m) {
      count(url.searchParams.get("limit") === "1" ? "qido-1row" : "qido-list");
      const s = seriesByUid(m[1]);
      if (!s) return json(res, []);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? s.count);
      const rows = [];
      for (let i = offset; i < Math.min(s.count, offset + limit); i += 1) rows.push(qidoInstance(s, i));
      return json(res, rows);
    }
    m = /^\/studies\/[^/]+\/series\/([^/]+)\/metadata$/.exec(dw);
    if (m) {
      count("series-metadata");
      const s = seriesByUid(m[1]);
      if (!s) return json(res, [], 404);
      return json(res, Array.from({ length: s.count }, (_, i) => dataset(s, i)));
    }
    m = /^\/studies\/[^/]+\/series\/([^/]+)\/instances\/([^/]+)\/(metadata|frames\/1|rendered)$/.exec(dw);
    if (m) {
      const s = seriesByUid(m[1]);
      const i = s ? Number(m[2].slice(s.uid.length + 1)) - 1 : -1;
      if (!s || !(i >= 0 && i < s.count)) return json(res, { error: "no instance" }, 404);
      if (m[3] === "metadata") {
        count("instance-metadata");
        return json(res, [dataset(s, i)]);
      }
      if (m[3] === "rendered") {
        count("rendered");
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(png(s, i));
      }
      count("frame");
      const accept = String(req.headers.accept ?? "");
      const ts = /transfer-syntax=([0-9.*]+)/i.exec(accept)?.[1] ?? "*";
      const wantsJls = /image\/jls/i.test(accept) || ts === JLS_TS;
      if (!wantsJls && ts !== "*" && ts !== "1.2.840.10008.1.2.1") {
        return json(res, { error: `cannot transcode to ${ts}` }, 406);
      }
      const key = `${s.id}:${i}`;
      if (!stats.firstFrameAt) stats.firstFrameAt = Date.now();
      if (!stats.frames.has(key)) {
        stats.frames.add(key);
        stats.lastNewFrameAt = Date.now();
      }
      stats.frameRequests += 1;
      let body = frame(s, i);
      let partType = "application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1";
      let type = "application/octet-stream";
      if (wantsJls) {
        body = jlsCache.get(key) ?? (await jlsEncode(body));
        jlsCache.set(key, body);
        partType = `image/jls; transfer-syntax=${JLS_TS}`;
        type = "image/jls";
        stats.jlsFrames += 1;
      }
      stats.bytesOut += body.length;
      const boundary = "phantomframe";
      res.writeHead(200, {
        "content-type": `multipart/related; type="${type}"; boundary=${boundary}`,
      });
      return res.end(
        Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Type: ${partType}\r\n\r\n`, "latin1"),
          body,
          Buffer.from(`\r\n--${boundary}--`, "latin1"),
        ])
      );
    }
    return json(res, { error: "unsupported" }, 404);
  } catch (err) {
    console.error(err);
    json(res, { error: String(err) }, 500);
  }
});

// --warm 1 renders (and JLS-encodes) the thin axial series before listening,
// so phantom CPU never shows up in a latency benchmark.
if (args.get("warm") === "1") {
  const t0 = Date.now();
  const s0 = SERIES[0];
  for (let i = 0; i < s0.count; i += 1) {
    const raw = frame(s0, i);
    jlsCache.set(`${s0.id}:${i}`, await jlsEncode(raw));
  }
  const raw = s0.count * N * N * 2;
  let jls = 0;
  for (const b of jlsCache.values()) jls += b.length;
  console.log(
    `warmed ${s0.count} frames in ${Date.now() - t0} ms — raw ${(raw / 1e6).toFixed(1)} MB, ` +
      `JPEG-LS ${(jls / 1e6).toFixed(1)} MB (${(raw / jls).toFixed(2)}x)`
  );
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`phantom orthanc on http://127.0.0.1:${PORT} — study ${STUDY_UID}`);
});
