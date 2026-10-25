import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dicomWebRoot,
  imagingConfigured,
  resolveImagingBackend,
  upstreamAccept,
  WADO_FRAME_ACCEPT,
  type ImagingEnv,
} from "./imagingBackend.ts";
import { dicomJsonString, looksLikeDicomUid, readDicomUids } from "./healthcareDicom.ts";

const HEALTHCARE: ImagingEnv = {
  healthcareProject: "my-project",
  healthcareLocation: "us-east4",
  healthcareDataset: "flowrad",
  healthcareDicomStore: "flowrad-dicom",
};

test("local Orthanc stays selected when ORTHANC_URL is set", () => {
  const env: ImagingEnv = { ...HEALTHCARE, orthancUrl: "http://127.0.0.1:8042" };
  assert.equal(resolveImagingBackend(env), "orthanc");
  assert.equal(imagingConfigured(env), true);
  assert.equal(dicomWebRoot(env), "http://127.0.0.1:8042/dicom-web");
});

test("Healthcare is selected when it is configured and Orthanc is not", () => {
  assert.equal(resolveImagingBackend(HEALTHCARE), "healthcare");
  assert.equal(
    dicomWebRoot(HEALTHCARE),
    "https://healthcare.googleapis.com/v1/projects/my-project/locations/us-east4/datasets/flowrad/dicomStores/flowrad-dicom/dicomWeb"
  );
});

test("DICOMWEB_BACKEND=healthcare wins over a local Orthanc URL", () => {
  const env: ImagingEnv = { ...HEALTHCARE, dicomwebBackend: "healthcare", orthancUrl: "http://127.0.0.1:8042" };
  assert.equal(resolveImagingBackend(env), "healthcare");
  assert.equal(imagingConfigured(env), true);
});

test("explicit Orthanc backend is unconfigured without ORTHANC_URL", () => {
  const env: ImagingEnv = { dicomwebBackend: "orthanc" };
  assert.equal(resolveImagingBackend(env), "orthanc");
  assert.equal(imagingConfigured(env), false);
});

test("HEALTHCARE_DICOMWEB_URL overrides the resource ids", () => {
  const env: ImagingEnv = {
    dicomwebBackend: "healthcare",
    healthcareDicomwebUrl: "https://healthcare.googleapis.com/v1/projects/p/locations/l/datasets/d/dicomStores/s/dicomWeb/",
  };
  assert.equal(
    dicomWebRoot(env),
    "https://healthcare.googleapis.com/v1/projects/p/locations/l/datasets/d/dicomStores/s/dicomWeb"
  );
});

test("frame Accept asks for the stored transfer syntax", () => {
  assert.equal(upstreamAccept("studies/1/series/2/instances/3/frames/1", null), WADO_FRAME_ACCEPT);
  assert.equal(
    upstreamAccept("studies/1/series/2/instances/3/frames/1", "application/octet-stream"),
    WADO_FRAME_ACCEPT
  );
  const cornerstone = "multipart/related; type=application/octet-stream; transfer-syntax=*";
  assert.equal(
    upstreamAccept("studies/1/series/2/instances/3/frames/1", cornerstone),
    cornerstone
  );
});

test("rendered thumbnails are requested as a single JPEG", () => {
  assert.equal(
    upstreamAccept("studies/1/series/2/instances/3/rendered", "image/avif,image/webp,image/*"),
    "image/jpeg"
  );
});

test("metadata Accept is forwarded unchanged", () => {
  assert.equal(
    upstreamAccept("studies/1/series/2/metadata", "application/dicom+json"),
    "application/dicom+json"
  );
});

test("dicomJsonString reads UIDs and alphabetic person names", () => {
  assert.equal(dicomJsonString({ "00080018": { vr: "UI", Value: ["1.2.3"] } }, "00080018"), "1.2.3");
  assert.equal(
    dicomJsonString({ "00100010": { vr: "PN", Value: [{ Alphabetic: "Anon" }] } }, "00100010"),
    "Anon"
  );
  assert.equal(dicomJsonString(undefined, "00080018"), undefined);
});

test("looksLikeDicomUid rejects Orthanc ids", () => {
  assert.equal(looksLikeDicomUid("1.2.840.113619.2.55"), true);
  assert.equal(looksLikeDicomUid("a1b2c3d4-e5f6-7890-abcd-ef1234567890"), false);
});

test("readDicomUids returns null for a non-DICOM buffer", () => {
  assert.equal(readDicomUids(new Uint8Array([0, 1, 2, 3]).buffer), null);
});
