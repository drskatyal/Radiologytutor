/** Test-only GCS + Healthcare HTTP, backed entirely by synthetic in-memory bytes. */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { readFileSync } from "node:fs";
import { parseDicom } from "dicom-parser";
import { Compute, GoogleAuth } from "google-auth-library";
import { PROVISIONAL_GCS_BUCKET_ENV } from "../envSchema";
import { resetGcpAccessTokenCache } from "../gcpAuth";
import { resetDicomCdnConfig } from "../dicomCdn/config";

export const CLOUD_ROOT = "https://healthcare.googleapis.com/v1/projects/radlearn-app/locations/europe-west2/datasets/radlearn/dicomStores/radlearn-dicom/dicomWeb";
export const FIXTURE = JSON.parse(readFileSync("fixtures/synthetic/study.json", "utf8")).instances[0];

export function syntheticPart10(): Buffer {
  const element = (hex: string, vr: string, value: Buffer) => {
    const header = Buffer.alloc(vr === "OW" ? 12 : 8);
    header.writeUInt16LE(parseInt(hex.slice(0, 4), 16), 0); header.writeUInt16LE(parseInt(hex.slice(4), 16), 2);
    header.write(vr, 4);
    if (vr === "OW") header.writeUInt32LE(value.length, 8); else header.writeUInt16LE(value.length, 6);
    return Buffer.concat([header, value]);
  };
  const text = (value: string, vr: string) => {
    const bytes = Buffer.from(value); return bytes.length % 2 ? Buffer.concat([bytes, Buffer.from([vr === "UI" ? 0 : 32])]) : bytes;
  };
  const ts = element("00020010", "UI", text("1.2.840.10008.1.2.1", "UI"));
  const length = Buffer.alloc(4); length.writeUInt32LE(ts.length);
  const entries = Object.entries(FIXTURE.metadata).filter(([key]) => !key.startsWith("0002")).sort(([a], [b]) => a.localeCompare(b));
  const dataset = entries.map(([key, raw]) => {
    const value = raw as { vr: string; Value: Array<string | number | { Alphabetic: string }> };
    const bytes = value.vr === "US" ? Buffer.alloc(value.Value.length * 2) : text(value.Value.map(v => typeof v === "object" ? v.Alphabetic : v).join("\\"), value.vr);
    if (value.vr === "US") value.Value.forEach((n, i) => bytes.writeUInt16LE(Number(n), i * 2));
    return element(key, value.vr, bytes);
  });
  return Buffer.concat([Buffer.alloc(128), Buffer.from("DICM"), element("00020000", "UL", length), ts, ...dataset, element("7FE00010", "OW", readFileSync(`fixtures/synthetic/${FIXTURE.frameFiles[0]}`))]);
}

export async function withMockCloud(t: TestContext, run: (cloud: {
  objects: Map<string, { bytes: Buffer; contentType: string }>;
  instances: Map<string, Buffer>;
  requests: Array<{ url: string; init?: RequestInit }>;
}) => Promise<void>) {
  const keys = [PROVISIONAL_GCS_BUCKET_ENV, "DICOMWEB_BACKEND", "HEALTHCARE_PROJECT", "HEALTHCARE_LOCATION", "HEALTHCARE_DATASET", "HEALTHCARE_DICOM_STORE", "HEALTHCARE_DICOMWEB_URL", "ORTHANC_URL", "DICOM_CDN_BUILD", "DICOM_CDN_DISABLED", "GOOGLE_ACCESS_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS"];
  const saved = keys.map(key => process.env[key]);
  keys.forEach(key => { delete process.env[key]; });
  Object.assign(process.env, { [PROVISIONAL_GCS_BUCKET_ENV]: "synthetic-private-bucket", DICOMWEB_BACKEND: "healthcare", HEALTHCARE_PROJECT: "radlearn-app", HEALTHCARE_LOCATION: "europe-west2", HEALTHCARE_DATASET: "radlearn", HEALTHCARE_DICOM_STORE: "radlearn-dicom", DICOM_CDN_BUILD: "off" });
  // These must be ignored. Neither a credential file nor an injected token is ADC here.
  process.env.GOOGLE_APPLICATION_CREDENTIALS = "/forbidden-synthetic-key-file.json";
  process.env.GOOGLE_ACCESS_TOKEN = "must-not-be-used";
  resetGcpAccessTokenCache(); resetDicomCdnConfig();
  t.mock.method(GoogleAuth.prototype, "getApplicationDefault", () => { throw new Error("Credential discovery is forbidden in this test"); });
  t.mock.method(Compute.prototype, "getAccessToken", async () => ({ token: "synthetic-adc-token" }));
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const instances = new Map<string, Buffer>();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/dicom+json" } });
  const metadata = () => [...instances.values()].map(bytes => {
    const ds = parseDicom(bytes);
    const row = structuredClone(FIXTURE.metadata);
    for (const [tag, vr] of [["0020000D", "UI"], ["0020000E", "UI"], ["00080018", "UI"]]) row[tag] = { vr, Value: [ds.string(`x${tag.toLowerCase()}`)] };
    for (const tag of ["00100010", "00100020"]) delete row[tag];
    return row;
  });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); requests.push({ url: url.href, init });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-adc-token");
    if (url.origin === "https://storage.googleapis.com") {
      if (init?.method === "POST") {
        const boundary = new Headers(init.headers).get("content-type")!.split("boundary=")[1];
        const parts = Buffer.from(init.body as Uint8Array).toString("latin1").split(`--${boundary}`);
        const meta = JSON.parse(parts[1].split("\r\n\r\n")[1].trim());
        const body = parts[2].slice(parts[2].indexOf("\r\n\r\n") + 4, -2);
        objects.set(meta.name, { bytes: Buffer.from(body, "latin1"), contentType: meta.contentType });
        assert.doesNotMatch(JSON.stringify(meta), /publicRead|allUsers/);
        return json({ name: meta.name });
      }
      if (url.pathname.endsWith("/o")) return json({ items: [...objects.keys()].filter(key => key.startsWith(url.searchParams.get("prefix") ?? "")).map(name => ({ name })) });
      const key = decodeURIComponent(url.pathname.split("/o/")[1]);
      if (init?.method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
      const found = objects.get(key); if (!found) return new Response(null, { status: 404 });
      const range = new Headers(init?.headers).get("range")?.match(/bytes=(\d+)-(\d+)/);
      const bytes = range ? found.bytes.subarray(Number(range[1]), Number(range[2]) + 1) : found.bytes;
      return new Response(new Uint8Array(bytes), { status: range ? 206 : 200, headers: { "Content-Type": found.contentType } });
    }
    assert.ok(url.href.startsWith(CLOUD_ROOT + "/"), "NO LIVE GCP CALL WAS MADE: unexpected URL blocked");
    if (init?.method === "POST") {
      assert.match(new Headers(init.headers).get("content-type")!, /^multipart\/related; type="application\/dicom"; boundary=/);
      const body = Buffer.from(init.body as Uint8Array);
      const boundary = new Headers(init.headers).get("content-type")!.split("boundary=")[1];
      const bytes = body.subarray(body.indexOf("\r\n\r\n") + 4, body.length - Buffer.byteLength(`\r\n--${boundary}--\r\n`));
      const sop = parseDicom(bytes).string("x00080018")!;
      instances.set(sop, bytes);
      return json({ "00081199": { vr: "SQ", Value: [{ "00081155": { vr: "UI", Value: [sop] } }] } });
    }
    if (/\/instances\/[^/]+$/.test(url.pathname)) {
      const bytes = instances.get(decodeURIComponent(url.pathname.split("/").pop()!));
      return bytes ? new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/dicom" } }) : new Response(null, { status: 404 });
    }
    return json(metadata());
  });
  try { await run({ objects, instances, requests }); }
  finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    resetGcpAccessTokenCache(); resetDicomCdnConfig();
  }
}
