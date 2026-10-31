import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { readDicomCdnConfig } from "./config";
import { signCdnUrlPrefix } from "./sign";

// Key from Cloud CDN's documentation format: 16 random bytes, base64url.
const KEY = { keyName: "radlearn-dicom-1", keyBase64Url: "nZtRohdNF9m3cKM24IcK4w==" };

test("signed prefix has Cloud CDN's field order and a verifiable HMAC-SHA1", () => {
  const prefix = "https://dicom-cdn.example.org/dicom/v1/1.2.3/1.2.3.4/abcdef0123456789/";
  const query = signCdnUrlPrefix(prefix, KEY, 1_900_000_000);
  const params = new URLSearchParams(query);
  assert.deepEqual([...params.keys()], ["URLPrefix", "Expires", "KeyName", "Signature"]);
  assert.equal(
    Buffer.from(params.get("URLPrefix")!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    prefix
  );
  assert.equal(params.get("Expires"), "1900000000");
  assert.equal(params.get("KeyName"), "radlearn-dicom-1");

  const policy = query.slice(0, query.indexOf("&Signature="));
  const expected = createHmac("sha1", Buffer.from(KEY.keyBase64Url, "base64"))
    .update(policy)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  assert.equal(params.get("Signature"), expected);
  assert.ok(!/[+/]/.test(query.split("&Signature=")[1]), "signature is base64url");
});

test("a different series prefix gets a different signature", () => {
  const a = signCdnUrlPrefix("https://cdn.example/dicom/v1/1.2/1.2.3/aaaaaaaa/", KEY, 1_900_000_000);
  const b = signCdnUrlPrefix("https://cdn.example/dicom/v1/1.2/1.2.4/aaaaaaaa/", KEY, 1_900_000_000);
  assert.notEqual(a.split("Signature=")[1], b.split("Signature=")[1]);
});

test("config: off by default, proxy without a CDN, never an unsigned CDN", () => {
  assert.equal(readDicomCdnConfig({} as NodeJS.ProcessEnv), null);
  const proxy = readDicomCdnConfig({ DICOM_CDN_BUCKET: "radlearn-app-dicom-cdn" } as unknown as NodeJS.ProcessEnv)!;
  assert.equal(proxy.delivery.mode, "proxy");
  assert.equal(proxy.autoBuild, true);
  assert.throws(
    () => readDicomCdnConfig({ DICOM_CDN_BUCKET: "b-ucket", DICOM_CDN_URL: "https://cdn.example" } as unknown as NodeJS.ProcessEnv),
    /signed access only/
  );
  assert.throws(() => readDicomCdnConfig({ DICOM_CDN_BUCKET: "gs://bucket" } as unknown as NodeJS.ProcessEnv), /bare bucket/);
  const cdn = readDicomCdnConfig({
    DICOM_CDN_BUCKET: "radlearn-app-dicom-cdn",
    DICOM_CDN_URL: "https://dicom-cdn.example/",
    DICOM_CDN_KEY_NAME: "k",
    DICOM_CDN_KEY: "nZtRohdNF9m3cKM24IcK4w==",
    DICOM_CDN_URL_TTL_SECONDS: "5",
    DICOM_CDN_BUILD: "off",
  } as unknown as NodeJS.ProcessEnv)!;
  assert.equal(cdn.delivery.mode, "cdn");
  assert.equal(cdn.delivery.mode === "cdn" && cdn.delivery.origin, "https://dicom-cdn.example");
  assert.equal(cdn.urlTtlSeconds, 60, "clamped");
  assert.equal(cdn.autoBuild, false);
  assert.equal(readDicomCdnConfig({ DICOM_CDN_BUCKET: "abc", DICOM_CDN_DISABLED: "1" } as unknown as NodeJS.ProcessEnv), null);
});
