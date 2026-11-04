#!/usr/bin/env node
// Mini DICOMweb archive for local development and end-to-end tests of
// "store and share" when no Orthanc or Cloud Healthcare store is at hand.
//
//   node scripts/dev/mini-dicomweb.mjs --port 8042
//   ORTHANC_URL=http://127.0.0.1:8042 VIEWER_DEV_SIGN_IN=1 npm run dev
//
// In memory, uncompressed (explicit/implicit VR little endian) instances only.
// Implements the slice the app uses: STOW-RS, QIDO instances/series, series
// and instance metadata (DICOM JSON), WADO frames, instance retrieve, and
// Orthanc's /tools/lookup + DELETE /studies/{id} for deletes.
// NOT a conformance test of anything; never point it at real patient data.

import http from "node:http";
import dicomParser from "dicom-parser";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const PORT = Number(args.get("port") ?? 8042);

/** studyUid -> seriesUid -> sopUid -> { bytes, ds } */
const studies = new Map();

const STRING_VRS = new Set(["AE", "AS", "CS", "DA", "DS", "DT", "IS", "LO", "LT", "SH", "ST", "TM", "UC", "UI", "UR", "UT", "PN"]);
const IMPLICIT_VR = {
  x00080016: "UI", x00080018: "UI", x0020000d: "UI", x0020000e: "UI", x00200052: "UI", x00080060: "CS",
  x00280010: "US", x00280011: "US", x00280100: "US", x00280101: "US", x00280102: "US", x00280103: "US",
  x00280002: "US", x00280004: "CS", x00280030: "DS", x00200032: "DS", x00200037: "DS", x00200013: "IS",
  x00200011: "IS", x00281050: "DS", x00281051: "DS", x00281052: "DS", x00281053: "DS", x00180050: "DS",
  x0008103e: "LO", x00081030: "LO", x00280008: "IS", x00080008: "CS", x00020010: "UI",
};

function toJson(ds) {
  const out = {};
  for (const [key, el] of Object.entries(ds.elements)) {
    const tag = key.slice(1).toUpperCase();
    if (tag.startsWith("0002") || tag === "7FE00010" || el.items) continue;
    const vr = el.vr ?? IMPLICIT_VR[key];
    if (!vr) continue;
    let Value;
    if (STRING_VRS.has(vr)) {
      const s = ds.string(key);
      if (s == null || s === "") {
        out[tag] = { vr };
        continue;
      }
      const parts = s.split("\\");
      if (vr === "PN") Value = parts.map((p) => ({ Alphabetic: p }));
      else if (vr === "DS") Value = parts.map(Number);
      else if (vr === "IS") Value = parts.map((p) => parseInt(p, 10));
      else Value = parts;
    } else if (vr === "US") Value = [ds.uint16(key)];
    else if (vr === "SS") Value = [ds.int16(key)];
    else if (vr === "UL") Value = [ds.uint32(key)];
    else if (vr === "FL") Value = [ds.float(key)];
    else if (vr === "FD") Value = [ds.double(key)];
    else continue;
    out[tag] = { vr, Value };
  }
  return out;
}

function instanceJson(inst) {
  const json = toJson(inst.ds);
  json["00083002"] = { vr: "UI", Value: [inst.ds.string("x00020010")] };
  return json;
}

function* allInstances(studyUid) {
  const st = studies.get(studyUid);
  if (!st) return;
  for (const [seriesUid, series] of st) for (const [sop, inst] of series) yield { seriesUid, sop, inst };
}

function parseMultipart(body, contentType) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType ?? "");
  if (!m) return [body];
  const delim = Buffer.from(`--${m[1]}`);
  const parts = [];
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    const headEnd = body.indexOf("\r\n\r\n", pos);
    if (headEnd < 0) break;
    const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delim]), headEnd + 4);
    if (next < 0) break;
    parts.push(body.subarray(headEnd + 4, next));
    pos = next + 2;
  }
  return parts;
}

function send(res, status, body, type = "application/dicom+json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent);

  // Orthanc REST used for deletes.
  if (req.method === "POST" && url.pathname === "/tools/lookup") {
    const uid = body.toString().trim();
    return send(res, 200, studies.has(uid) ? [{ ID: uid, Type: "Study" }] : [], "application/json");
  }
  if (req.method === "DELETE" && p[0] === "studies" && p.length === 2) {
    studies.delete(p[1]);
    return send(res, 200, {}, "application/json");
  }
  if (p[0] !== "dicom-web") return send(res, 404, "not found", "text/plain");
  const q = p.slice(1);

  if (req.method === "POST" && q.length === 1 && q[0] === "studies") {
    let stored = 0;
    for (const part of parseMultipart(body, req.headers["content-type"])) {
      const bytes = new Uint8Array(part);
      const ds = dicomParser.parseDicom(bytes);
      const study = ds.string("x0020000d");
      const series = ds.string("x0020000e");
      const sop = ds.string("x00080018");
      if (!study || !series || !sop) continue;
      if (!studies.has(study)) studies.set(study, new Map());
      const st = studies.get(study);
      if (!st.has(series)) st.set(series, new Map());
      st.get(series).set(sop, { bytes: Buffer.from(bytes), ds });
      stored += 1;
    }
    return send(res, stored ? 200 : 400, {});
  }

  if (req.method !== "GET" || q[0] !== "studies" || !q[1]) return send(res, 404, "not found", "text/plain");
  const [, studyUid, l2, seriesUid, l4, sop, l6, frameNo] = q;
  const st = studies.get(studyUid);
  if (!st) return send(res, 404, []);

  if (l2 === "instances" && !seriesUid) {
    return send(res, 200, [...allInstances(studyUid)].map(({ inst }) => instanceJson(inst)));
  }
  if (l2 === "series" && !seriesUid) {
    return send(res, 200, [...st].map(([uid, s]) => {
      const first = s.values().next().value;
      return { ...instanceJson(first), "0020000E": { vr: "UI", Value: [uid] }, "00201209": { vr: "IS", Value: [s.size] } };
    }));
  }
  const series = l2 === "series" ? st.get(seriesUid) : null;
  if (!series) return send(res, 404, []);
  if (l4 === "metadata" || (l4 === "instances" && !sop)) {
    return send(res, 200, [...series.values()].map(instanceJson));
  }
  const inst = l4 === "instances" ? series.get(sop) : null;
  if (!inst) return send(res, 404, []);
  if (l6 === "metadata") return send(res, 200, [instanceJson(inst)]);
  if (l6 === "frames" && frameNo) {
    const el = inst.ds.elements.x7fe00010;
    const pixels = inst.bytes.subarray(el.dataOffset, el.dataOffset + el.length);
    const boundary = "mini-dicomweb-frame";
    const ts = inst.ds.string("x00020010");
    const head = Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream; transfer-syntax=${ts}\r\n\r\n`);
    res.writeHead(200, { "Content-Type": `multipart/related; type="application/octet-stream"; boundary=${boundary}` });
    return res.end(Buffer.concat([head, pixels, Buffer.from(`\r\n--${boundary}--\r\n`)]));
  }
  if (!l6) {
    const boundary = "mini-dicomweb-instance";
    res.writeHead(200, { "Content-Type": `multipart/related; type="application/dicom"; boundary=${boundary}` });
    return res.end(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`), inst.bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]));
  }
  return send(res, 404, "not found", "text/plain");
});

server.listen(PORT, "127.0.0.1", () => console.log(`mini-dicomweb on http://127.0.0.1:${PORT}`));
