import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { Compute } from "google-auth-library";
import { parseDicom } from "dicom-parser";
import { NextRequest } from "next/server";
import { ENV_SCHEMA, PROVISIONAL_GCS_BUCKET_ENV, missingProductionEnv, readGcsBucket, assertDurableStorageConfigured } from "./envSchema";
import { gcpAccessToken, resetGcpAccessTokenCache } from "./gcpAuth";
import { openGcsStore } from "./gcs";
import { getObject, putObject } from "./objectStorage";
import { persistImportedCase } from "./importObjects";
import { cacheGet, resetMemoryCache } from "./frameCache";
import { readDicomCdnConfig } from "./dicomCdn/config";
import { buildSeriesBundle, dicomwebArchiveReader } from "./dicomCdn/pack";
import { openBundleStore } from "./dicomCdn/store";
import { healthcareStoreInstance, healthcareFindStudy, healthcareSeriesMeta, healthcareSeriesInstances, healthcareQido, readDicomUids } from "./healthcareDicom";
import { resolveImagingBackend } from "./imagingBackend";
import { CLOUD_ROOT, syntheticPart10, withMockCloud } from "./fixtures/cloudMock";
import type { CaseData } from "./types";

// Route/case modules are imported only after this local-only configuration.
process.env.DATA_DIR = `${process.cwd()}/.radlearn-tmp/c2-unit-data`;
process.env.MONGODB_URI = "";
mkdirSync(process.env.DATA_DIR, { recursive: true });
const arrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

test("C2 schema uses the agreed names and one provisional bucket; errors expose names only", () => {
  const secrets = Object.entries(ENV_SCHEMA).filter(([,v]) => v.kind === "secret").map(([k]) => k).sort();
  assert.deepEqual(secrets, ["GEMINI_API_KEY", "BETTER_AUTH_SECRET", "MONGODB_URI", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ELEVENLABS_API_KEY", "TRUSTED_PROXY_SECRET"].sort());
  assert.deepEqual(Object.entries(ENV_SCHEMA).filter(([, v]) => "provisional" in v).map(([k]) => k), [PROVISIONAL_GCS_BUCKET_ENV]);
  assert.ok(missingProductionEnv({ BETTER_AUTH_SECRET: "synthetic-private-value" }).includes(PROVISIONAL_GCS_BUCKET_ENV));
  assert.doesNotMatch(JSON.stringify(missingProductionEnv({ BETTER_AUTH_SECRET: "synthetic-private-value" })), /synthetic-private-value/);
  assert.equal(readGcsBucket({ [PROVISIONAL_GCS_BUCKET_ENV]: "synthetic-private-bucket" }), "synthetic-private-bucket");
  assert.throws(() => readGcsBucket({ [PROVISIONAL_GCS_BUCKET_ENV]: "gs://do-not-echo" }), e => e instanceof Error && !e.message.includes("do-not-echo"));
  assert.throws(() => assertDurableStorageConfigured({ DICOMWEB_BACKEND: "healthcare" }), /required for durable/);
  assert.throws(() => assertDurableStorageConfigured({ K_SERVICE: "synthetic" }), /required for durable/);
  assert.doesNotThrow(() => assertDurableStorageConfigured({ DICOMWEB_BACKEND: "orthanc" }));
  assert.equal(resolveImagingBackend({}), "healthcare");
  assert.equal(resolveImagingBackend({ dicomwebBackend: "orthanc", orthancUrl: "http://localhost:8042" }), "orthanc");
});

test("C2 production deployment sources no longer wire R2 credentials or HMAC endpoints", () => {
  for (const file of ["deploy/gcp/deploy-app.sh", "deploy/gcp/setup.sh", "deploy/gcp/terraform/main.tf", "deploy/gcp/terraform/run.tf"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /R2_(?:ENDPOINT|BUCKET|ACCESS_KEY_ID|SECRET_ACCESS_KEY)/, file);
    assert.match(source, /TRUSTED_PROXY_SECRET|radlearn-trusted-proxy-secret/, file);
  }
  const deploy = readFileSync("deploy/gcp/deploy-app.sh", "utf8");
  assert.match(deploy, /PROXY_SECRET_ID=radlearn-trusted-proxy-secret/);
  assert.match(deploy, /TRUSTED_PROXY_SECRET=\$\{PROXY_SECRET_ID\}:latest/);
  assert.doesNotMatch(deploy, /--secret="TRUSTED_PROXY_SECRET"/);
  const setup = readFileSync("deploy/gcp/setup.sh", "utf8");
  assert.match(setup, /PROXY_SECRET_ID=radlearn-trusted-proxy-secret/);
  assert.doesNotMatch(setup, /REQUIRED_SECRETS=\(.*TRUSTED_PROXY_SECRET/);
  const run = readFileSync("deploy/gcp/terraform/run.tf", "utf8");
  assert.match(run, /TRUSTED_PROXY_SECRET\s*=\s*"radlearn-trusted-proxy-secret"/);
  const main = readFileSync("deploy/gcp/terraform/main.tf", "utf8");
  assert.match(main, /"radlearn-trusted-proxy-secret"/);
  assert.doesNotMatch(main, /"TRUSTED_PROXY_SECRET"/);
});

test("C2 runtime ADC ignores injected tokens and credential-file discovery; failures/logs hide tokens", async t => {
  await withMockCloud(t, async () => {
    const logs = ["log", "info", "warn", "error", "debug"] as const;
    const spies = logs.map(name => t.mock.method(console, name, () => undefined));
    assert.equal(await gcpAccessToken(), "synthetic-adc-token");
    t.mock.method(Compute.prototype, "getAccessToken", async () => { throw new Error("synthetic-private-token"); });
    resetGcpAccessTokenCache();
    await assert.rejects(gcpAccessToken(), { message: "GCP runtime ADC authentication failed." });
    t.mock.method(Compute.prototype, "getAccessToken", async () => ({ token: null }));
    resetGcpAccessTokenCache();
    await assert.rejects(gcpAccessToken(), { message: "GCP runtime ADC authentication failed." });
    assert.equal(spies.reduce((n, spy) => n + spy.mock.calls.length, 0), 0);
  });
});

test("C2 private GCS JSON API supports binary objects, ranges, listing, deletion and misses with ADC", async t => {
  await withMockCloud(t, async ({ objects, requests }) => {
    const store = openGcsStore(readGcsBucket()!);
    const bytes = Buffer.from([0, 255, 13, 10, 1, 2]);
    await store.put("cases/synthetic/a b.bin", bytes, { contentType: "application/octet-stream", cacheControl: "private, no-store" });
    assert.deepEqual(await store.get("cases/synthetic/a b.bin"), new Uint8Array(bytes));
    assert.deepEqual(await store.getRange("cases/synthetic/a b.bin", 1, 3), new Uint8Array([255, 13, 10]));
    assert.deepEqual(await store.list("cases/"), ["cases/synthetic/a b.bin"]);
    assert.equal((await store.getObject("cases/synthetic/a b.bin"))?.contentType, "application/octet-stream");
    assert.equal(await store.get("absent"), null);
    assert.equal(await store.getRange("absent", 0, 1), null);
    assert.equal(await store.getObject("absent"), null);
    await store.delete("cases/synthetic/a b.bin");
    await store.delete("absent");
    assert.equal(objects.size, 0);
    assert.ok(requests.every(r => r.url.startsWith("https://storage.googleapis.com/")));
    assert.ok(requests.every(r => r.init?.signal instanceof AbortSignal));
  });
});

test("C2 GCS paginates and handles ignored Range; errors never echo upstream bodies", async t => {
  await withMockCloud(t, async () => {
    const store = openGcsStore(readGcsBucket()!);
    const pages: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      if (new Headers(init.headers).has("range")) return new Response(new Uint8Array([10, 20, 30, 40]));
      pages.push(url);
      return Response.json(url.includes("pageToken=") ? { items: [{ name: "b" }] } : { items: [{ name: "a" }], nextPageToken: "next page" });
    });
    assert.deepEqual(await store.list("cases/"), ["a", "b"]);
    assert.equal(pages.length, 2);
    assert.match(pages[1], /pageToken=next\+page/);
    assert.deepEqual(await store.getRange("a", 1, 2), new Uint8Array([20, 30]));
    t.mock.method(globalThis, "fetch", async () => new Response("synthetic-private-token", { status: 403 }));
    for (const op of [() => store.get("a"), () => store.getObject("a"), () => store.getRange("a", 0, 1), () => store.list("a"), () => store.delete("a"), () => store.put("a", Buffer.from("a"), { contentType: "text/plain", cacheControl: "private" })]) {
      await assert.rejects(op(), e => e instanceof Error && /403/.test(e.message) && !e.message.includes("synthetic-private-token"));
    }
  });
});

test("C2 audio and frame cache use GCS without R2, public URLs or ephemeral-disk fallback", async t => {
  await withMockCloud(t, async ({ objects, requests }) => {
    const { putAudio, getAudio } = await import("./audioStore");
    const clip = await putAudio(Buffer.from("synthetic-audio").toString("base64"), "audio/wav");
    assert.equal(clip.url, `/api/audio/${clip.id}`);
    assert.equal((await getAudio(clip.id))?.bytes.toString(), "synthetic-audio");
    assert.equal((await getAudio(clip.id))?.mimeType, "audio/wav");
    assert.equal(await getAudio("missing"), null);
    assert.equal(objects.size, 2);
    assert.deepEqual(await putObject("frames/synthetic", Buffer.from([1, 2]), "application/octet-stream"), { key: "frames/synthetic", url: null });
    resetMemoryCache();
    assert.equal((await cacheGet("frames/synthetic"))?.tier, "object");
    assert.equal((await cacheGet("frames/synthetic"))?.tier, "memory");
    resetMemoryCache();
    delete process.env[PROVISIONAL_GCS_BUCKET_ENV];
    const before = requests.length;
    await assert.rejects(putAudio("", "audio/wav"), /required for durable/);
    await assert.rejects(getAudio(clip.id), /required for durable/);
    assert.equal(await putObject("no-fallback", Buffer.from(""), "text/plain"), null);
    assert.equal(await getObject("no-fallback"), null);
    assert.equal(requests.length, before);
  });
});

test("C2 GCS transport failure is surfaced for durable audio and import snapshots", async t => {
  await withMockCloud(t, async () => {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
    const { putAudio } = await import("./audioStore");
    await assert.rejects(putAudio("c3ludGhldGlj", "audio/wav"), /GCS put -> 503/);
    const data: CaseData = JSON.parse(readFileSync("fixtures/synthetic/case.json", "utf8"));
    await assert.rejects(persistImportedCase("org_synthetic", data), /GCS put -> 503/);
  });
});

test("C2 case snapshots allowlist teaching content and reject non-placeholder identity before upload", async t => {
  await withMockCloud(t, async ({ objects, requests }) => {
    const data = JSON.parse(readFileSync("fixtures/synthetic/case.json", "utf8"));
    Object.assign(data, { patientId: "pat_synthetic_internal_reference", PatientName: "SYNTHETIC^TEST", PatientID: "SYN-001", shareToken: "synthetic-share", approval: { approved: true } });
    await persistImportedCase("org_synthetic", data);
    const snapshot = JSON.parse([...objects.values()][0].bytes.toString());
    assert.equal(snapshot.caseId, data.caseId);
    assert.equal(snapshot.findings[0].sopInstanceUID, data.findings[0].sopInstanceUID);
    assert.deepEqual(Object.keys(snapshot).sort(), ["schema", "kind", "caseId", "title", "modality", "findings"].sort());
    assert.doesNotMatch(JSON.stringify(snapshot), /PatientName|PatientID|patientId|pat_synthetic|shareToken|approval|synthetic-share/);
    const before = requests.length;
    await assert.rejects(persistImportedCase("org_synthetic", { ...data, PatientName: "FICTIONAL^EXAMPLE" }), /PHI review required/);
    await assert.rejects(persistImportedCase("org_synthetic", { ...data, title: "patient id: fictional-example" }), /PHI review required/);
    assert.equal(requests.length, before);
  });
});

test("C2 synthetic STOW then QIDO, metadata and WADO feed the existing GCS bundle path", async t => {
  await withMockCloud(t, async ({ objects, requests }) => {
    const bytes = syntheticPart10();
    const uids = readDicomUids(arrayBuffer(bytes))!;
    assert.ok(uids);
    const stored = await healthcareStoreInstance(arrayBuffer(bytes));
    assert.deepEqual(stored, { ID: uids.sop, ParentStudy: uids.study, ParentSeries: uids.series, Status: "Success" });
    assert.equal(await healthcareFindStudy(uids.study), uids.study);
    assert.equal((await healthcareSeriesMeta(uids.series)).firstInstanceUID, uids.sop);
    assert.equal((await healthcareSeriesInstances(uids.series))[0].sopInstanceUID, uids.sop);
    const reader = dicomwebArchiveReader();
    assert.equal((await reader.seriesMetadata(uids.study, uids.series)).length, 1);
    assert.equal((await reader.instancePixels(uids.study, uids.series, uids.sop)).bytes.length, 64 * 64 * 2);
    const config = readDicomCdnConfig()!;
    assert.deepEqual(config.store, { kind: "gcs", bucket: readGcsBucket() });
    assert.deepEqual(config.delivery, { mode: "proxy" });
    const result = await buildSeriesBundle(openBundleStore(config.store), uids.study, uids.series);
    assert.equal(result.stats.frames, 1);
    assert.deepEqual(result.index.sops, [uids.sop]);
    assert.ok([...objects.keys()].some(key => key.endsWith("index.json")));
    assert.ok(requests.some(r => r.url === `${CLOUD_ROOT}/studies` && r.init?.method === "POST"));
    const lastPut = requests.filter(r => r.init?.method === "POST" && r.url.includes("storage.googleapis.com")).at(-1)!;
    assert.match(Buffer.from(lastPut.init!.body as Uint8Array).toString(), /index\.json/);
  });
});

test("C2 STOW rejects malformed input, partial success, missing SOP acknowledgement and unproven conflicts", async t => {
  await withMockCloud(t, async ({ requests }) => {
    await assert.rejects(healthcareStoreInstance(new ArrayBuffer(4)), /400/);
    assert.equal(requests.length, 0);
    const bytes = arrayBuffer(syntheticPart10());
    const sop = readDicomUids(bytes)!.sop;
    const ack = { "00081199": { vr: "SQ", Value: [{ "00081155": { vr: "UI", Value: [sop] } }] } };
    for (const [status, body] of [[200, {}], [202, { ...ack, "00081198": { vr: "SQ", Value: [{}] } }], [200, { "00081199": { Value: [{ "00081155": { Value: ["1.2.999"] } }] } }], [409, {}], [403, {}]] as const) {
      t.mock.method(globalThis, "fetch", async () => Response.json(body, { status }));
      await assert.rejects(healthcareStoreInstance(bytes), /Healthcare STOW/);
    }
    t.mock.method(globalThis, "fetch", async () => Response.json(ack, { status: 409 }));
    assert.equal((await healthcareStoreInstance(bytes)).Status, "AlreadyStored");
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
    assert.deepEqual(await healthcareQido("studies"), []);
    t.mock.method(globalThis, "fetch", async () => new Response("synthetic-private-token", { status: 403 }));
    await assert.rejects(healthcareQido("studies"), { message: "Healthcare QIDO studies -> 403" });
  });
});

test("C2 upload de-identifies synthetic Part-10 before Healthcare STOW and writes a private GCS receipt", async t => {
  await withMockCloud(t, async ({ instances, objects }) => {
    const { ingestUpload } = await import("./uploadIngest");
    const source = syntheticPart10();
    const sourceUIDs = readDicomUids(arrayBuffer(source))!;
    const form = new FormData();
    form.append("files", new File([new Uint8Array(source)], "synthetic.dcm", { type: "application/dicom" }));
    const result = await ingestUpload("org_synthetic", form);
    assert.equal(result.status, 200);
    if (result.status !== 200) assert.fail("expected successful synthetic upload");
    assert.equal(result.body.stored, 1, JSON.stringify(result.body.failed));
    assert.equal(result.body.failed.length, 0);
    const stored = [...instances.values()][0];
    const ds = parseDicom(stored);
    assert.ok(!ds.string("x00100010"));
    assert.ok(!ds.string("x00100020"));
    assert.notEqual(ds.string("x00080018"), sourceUIDs.sop);
    assert.equal(result.body.series[0].firstInstanceUID, ds.string("x00080018"));
    const receipt = JSON.parse([...objects.values()][0].bytes.toString());
    assert.equal(receipt.kind, "upload_receipt");
    assert.equal(receipt.stored, 1);
    assert.equal(receipt.series[0].seriesInstanceUID, ds.string("x0020000e"));
    assert.doesNotMatch(JSON.stringify(receipt), /PatientName|PatientID|synthetic\.dcm/);
  });
});

test("C2 actual DICOMweb route denies anonymous GET/HEAD before ADC or any upstream request", async t => {
  await withMockCloud(t, async ({ requests }) => {
    const route = await import("../app/api/dicomweb/[...path]/route");
    for (const path of [["studies"], ["studies", "1.2.3", "series"], ["studies", "1.2.3", "series", "1.2.4", "metadata"], ["studies", "1.2.3", "series", "1.2.4", "instances", "1.2.5", "frames", "1"]]) {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await route[method](new NextRequest(`http://localhost/api/dicomweb/${path.join("/")}`, { method }), { params: { path } });
        assert.equal(response.status, 401);
      }
    }
    delete process.env.HEALTHCARE_PROJECT;
    assert.equal((await route.GET(new NextRequest("http://localhost/api/dicomweb/studies/1.2.3"), { params: { path: ["studies", "1.2.3"] } })).status, 401);
    assert.equal(requests.length, 0);
  });
});
