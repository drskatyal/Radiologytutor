import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseDicom } from "dicom-parser";
import AdmZip from "adm-zip";
import { BLOCKING_TAG_HEX, blankBlockingIdentityTags } from "./anonymizeTeachingDicom.ts";
import { BLOCKING_PHI_TAGS, DeidFailError, evaluateDeid, inspectDicomBytes } from "./deid.ts";
import { readDicomUids } from "./healthcareDicom.ts";
import { TEACHING_DEID_FAILURE, remapTeachingUid } from "./teachingDeidentify.ts";

// cases.ts captures DATA_DIR at import. Set it before the upload route loads.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "flowrad-teach-upload-"));

const RAW = join(process.cwd(), "public/dicom/emri_small.dcm");
const TEACH = join(process.cwd(), "public/dicom/teach_anon_mr.dcm");

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pixelBytes(bytes: Uint8Array): Uint8Array {
  const dataSet = parseDicom(bytes);
  const el = dataSet.elements.x7fe00010;
  assert.ok(el, "pixel data element");
  return bytes.slice(el.dataOffset, el.dataOffset + el.length);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve(addr.port);
    });
  });
}

test("blocking tag map covers every ingest identity keyword", () => {
  for (const keyword of BLOCKING_PHI_TAGS) {
    assert.match(BLOCKING_TAG_HEX[keyword], /^[0-9A-F]{8}$/);
  }
});

test("emri_small.dcm is refused because PatientBirthDate is still populated", () => {
  const bytes = new Uint8Array(readFileSync(RAW));
  const report = inspectDicomBytes(asArrayBuffer(bytes));
  const verdict = evaluateDeid(report);
  assert.equal(verdict.pass, false);
  assert.deepEqual(
    verdict.blocking.map((hit) => hit.tag),
    ["PatientBirthDate"]
  );
  assert.equal(parseDicom(bytes).string("x00100030"), "20000101");
});

test("teach_anon_mr.dcm has identity tags blanked and passes the gate", () => {
  const raw = new Uint8Array(readFileSync(RAW));
  const teach = new Uint8Array(readFileSync(TEACH));
  const report = inspectDicomBytes(asArrayBuffer(teach));
  assert.equal(evaluateDeid(report).pass, true);
  assert.equal(report.pixelOcrScanned, false);
  const parsed = parseDicom(teach);
  assert.equal(parsed.string("x00100010"), undefined);
  assert.equal(parsed.string("x00100020"), undefined);
  assert.equal(parsed.string("x00100030"), undefined);
  assert.deepEqual(pixelBytes(teach), pixelBytes(raw));
  const rawUids = readDicomUids(asArrayBuffer(raw));
  const teachUids = readDicomUids(asArrayBuffer(teach));
  assert.deepEqual(teachUids, rawUids);
  assert.ok(teachUids);
});

test("blanking removes a nested patient name without touching other sequence bytes", () => {
  const name = element("00100010", "PN", Buffer.from("SMITH^JANE"));
  const kept = element("00080100", "SH", Buffer.from("CODE"));
  const seq = element("00081032", "SQ", item(Buffer.concat([name, kept])));
  const file = part10(seq);
  const { bytes, removed } = blankBlockingIdentityTags(file);
  assert.deepEqual(removed, ["00100010"]);
  assert.equal(Buffer.from(bytes).includes(Buffer.from("SMITH^JANE")), false);
  assert.equal(Buffer.from(bytes).includes(Buffer.from("CODE")), true);
  const again = blankBlockingIdentityTags(bytes);
  assert.deepEqual(again.removed, []);
});

describe("studio upload ingest", { concurrency: false }, () => {
  test("POST /api/upload still requires an author session", async () => {
    const { POST } = await import("../app/api/upload/route.ts");
    const res = await POST(new Request("http://127.0.0.1/api/upload", { method: "POST" }) as never);
    assert.equal(res.status, 401);
  });

  test("a study with PatientBirthDate is stored after automatic de-id", async () => {
    const saved = {
      DICOMWEB_BACKEND: process.env.DICOMWEB_BACKEND,
      ORTHANC_URL: process.env.ORTHANC_URL,
    };
    const store = createStubArchive();
    const port = await listen(store.server);
    process.env.DICOMWEB_BACKEND = "orthanc";
    process.env.ORTHANC_URL = `http://127.0.0.1:${port}`;
    try {
      const { ingestUpload } = await import("./uploadIngest.ts");
      const { orthancIngestInstance } = await import("./orthanc.ts");
      const raw = readFileSync(RAW);
      const teach = readFileSync(TEACH);
      const rawUids = readDicomUids(asArrayBuffer(new Uint8Array(raw)));
      assert.ok(rawUids);

      await assert.rejects(
        () => orthancIngestInstance(asArrayBuffer(new Uint8Array(raw))),
        DeidFailError
      );
      assert.equal(store.stowed, 0);

      const stored = await ingestUpload("org_test", formWith("emri_small.dcm", raw));
      assert.equal(stored.status, 200);
      if (stored.status !== 200) return;
      assert.equal(stored.body.stored, 1);
      assert.equal(stored.body.failed.length, 0);
      assert.equal(stored.body.deidentified, 1);
      assert.equal(stored.body.duplicates, 0);
      assert.equal(stored.body.series.length, 1);
      assert.equal(stored.body.series[0].studyInstanceUID, remapTeachingUid(rawUids.study));
      assert.equal(stored.body.series[0].seriesInstanceUID, remapTeachingUid(rawUids.series));
      assert.equal(stored.body.series[0].modality, "MR");
      assert.equal(stored.body.series[0].instances, 1);
      assert.equal(store.stowed, 1);
      const stowed = new Uint8Array(store.bodies[0]);
      assert.equal(evaluateDeid(inspectDicomBytes(asArrayBuffer(stowed))).pass, true);
      assert.equal(parseDicom(stowed).string("x00100030"), undefined);
      assert.deepEqual(pixelBytes(stowed), pixelBytes(new Uint8Array(raw)));

      const zip = new AdmZip();
      zip.addFile("nested/IM-0001-0026.dcm", raw);
      zip.addFile("readme.jpg", Buffer.from("not-dicom"));
      const zipped = await ingestUpload("org_test", formWith("study.zip", zip.toBuffer()));
      assert.equal(zipped.status, 200);
      if (zipped.status !== 200) return;
      assert.equal(zipped.body.stored, 0);
      assert.equal(zipped.body.duplicates, 1);
      assert.equal(zipped.body.failed.length, 0);
      assert.ok(zipped.body.skipped.some((s) => s.reason === "not a DICOM file"));
      assert.equal(store.stowed, 1);

      const copies = new FormData();
      copies.append("files", new File([new Uint8Array(raw)], "IM-0001-0026.dcm"));
      copies.append("files", new File([new Uint8Array(raw)], "IM-0001-0026(1).dcm"));
      const dup = await ingestUpload("org_test", copies);
      assert.equal(dup.status, 200);
      if (dup.status !== 200) return;
      assert.equal(dup.body.failed.length, 0);
      assert.equal(dup.body.stored, 0);
      assert.equal(dup.body.duplicates, 2);
      assert.equal(store.stowed, 1);

      const anon = await ingestUpload("org_test", formWith("teach_anon_mr.dcm", teach));
      assert.equal(anon.status, 200);
      if (anon.status !== 200) return;
      assert.equal(anon.body.failed.length, 0);
      assert.equal(anon.body.stored, 0);
      assert.equal(anon.body.duplicates, 1);

      const junk = Buffer.alloc(200);
      junk.write("DICM", 128);
      const rejected = await ingestUpload("org_test", formWith("IM-0001-0099.dcm", junk));
      assert.equal(rejected.status, 200);
      if (rejected.status !== 200) return;
      assert.equal(rejected.body.stored, 0);
      assert.equal(rejected.body.failed.length, 1);
      assert.equal(rejected.body.failed[0].reason, TEACHING_DEID_FAILURE);
      assert.equal(store.stowed, 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        store.server.close((err) => (err ? reject(err) : resolve()));
      });
      if (saved.DICOMWEB_BACKEND === undefined) delete process.env.DICOMWEB_BACKEND;
      else process.env.DICOMWEB_BACKEND = saved.DICOMWEB_BACKEND;
      if (saved.ORTHANC_URL === undefined) delete process.env.ORTHANC_URL;
      else process.env.ORTHANC_URL = saved.ORTHANC_URL;
    }
  });
});

function formWith(name: string, bytes: Buffer): FormData {
  const form = new FormData();
  form.append("files", new File([new Uint8Array(bytes)], name));
  return form;
}

function createStubArchive(): { server: Server; stowed: number; bodies: Buffer[] } {
  const state: {
    stowed: number;
    bodies: Buffer[];
    study?: string;
    series?: string;
    sop?: string;
  } = { stowed: 0, bodies: [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/instances") {
        const uids = readDicomUids(asArrayBuffer(body));
        if (!uids) {
          res.writeHead(400);
          res.end("not dicom");
          return;
        }
        if (state.sop === uids.sop) {
          res.writeHead(409);
          res.end("already exists");
          return;
        }
        state.stowed += 1;
        state.bodies.push(body);
        state.study = uids.study;
        state.series = uids.series;
        state.sop = uids.sop;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ID: "orthanc-instance",
            ParentStudy: "orthanc-study",
            ParentSeries: "orthanc-series",
            Status: "Success",
          })
        );
        return;
      }
      if (req.method === "GET" && url === "/studies/orthanc-study") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            MainDicomTags: {
              StudyInstanceUID: state.study,
              StudyDescription: "Teaching MR",
              StudyDate: "20000101",
            },
          })
        );
        return;
      }
      if (req.method === "GET" && url === "/series/orthanc-series") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            MainDicomTags: {
              SeriesInstanceUID: state.series,
              Modality: "MR",
              SeriesDescription: "T1",
            },
            Instances: ["orthanc-instance"],
          })
        );
        return;
      }
      if (req.method === "GET" && url === "/instances/orthanc-instance") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ MainDicomTags: { SOPInstanceUID: state.sop } }));
        return;
      }
      res.writeHead(404);
      res.end("missing");
    });
  });
  return {
    server,
    get stowed() {
      return state.stowed;
    },
    bodies: state.bodies,
  };
}

const LONG_VR = new Set(["OB", "OW", "OF", "SQ", "UT", "UN"]);

function element(tag: string, vr: string, value: Buffer): Buffer {
  const header = Buffer.alloc(LONG_VR.has(vr) ? 12 : 8);
  header.writeUInt16LE(Number.parseInt(tag.slice(0, 4), 16), 0);
  header.writeUInt16LE(Number.parseInt(tag.slice(4), 16), 2);
  header.write(vr, 4, "ascii");
  if (LONG_VR.has(vr)) {
    header.writeUInt16LE(0, 6);
    header.writeUInt32LE(value.length, 8);
  } else {
    header.writeUInt16LE(value.length, 6);
  }
  return Buffer.concat([header, value]);
}

function item(content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0xfffe, 0);
  header.writeUInt16LE(0xe000, 2);
  header.writeUInt32LE(content.length, 4);
  return Buffer.concat([header, content]);
}

function part10(dataset: Buffer): Uint8Array {
  const ts = Buffer.from("1.2.840.10008.1.2.1\0", "ascii");
  return new Uint8Array(Buffer.concat([Buffer.alloc(128), Buffer.from("DICM"), element("00020010", "UI", ts), dataset]));
}
