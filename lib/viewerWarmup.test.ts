import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import { WADORS_FRAME_ACCEPT } from "./dicomwebProxy";
import { resetViewerWarmup, warmOpeningFrame, warmViewerModules } from "./viewerWarmup";

// `warmOpeningFrame` is a browser helper; it bails out without a `window`.
// Install the two globals it touches so the request plan can be asserted.
const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

interface Call {
  url: string;
  accept: string | undefined;
  cache: string | undefined;
}

let calls: Call[] = [];
let respond: (url: string) => Response | null = () => null;

beforeEach(() => {
  calls = [];
  resetViewerWarmup();
  (globalThis as { window?: unknown }).window = globalThis;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, accept: headers.get("Accept") ?? undefined, cache: init?.cache });
    const result = respond(url);
    if (result) return result;
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = realWindow;
  resetViewerWarmup();
});

const ROOT = "/api/dicomweb";
const STUDY = "1.2.3";
const SERIES = "1.2.3.4";
const SOP = "1.2.3.4.5";

function qidoRow(sop: string): Response {
  return new Response(JSON.stringify([{ "00080018": { vr: "UI", Value: [sop] } }]), {
    status: 200,
    headers: { "content-type": "application/dicom+json" },
  });
}

test("a known teacher SOP skips the QIDO row and warms metadata + pixels", async () => {
  respond = (url) => (url.includes("/metadata") || url.includes("/frames/1")
    ? new Response("ok", { status: 200 })
    : null);
  const imageId = await warmOpeningFrame({
    wadoRsRoot: ROOT,
    studyInstanceUID: STUDY,
    seriesInstanceUID: SERIES,
    sopInstanceUID: SOP,
  });
  assert.equal(calls.length, 2, "metadata + frame, no QIDO");
  assert.ok(calls.every((call) => !call.url.includes("/instances?")));
  assert.equal(
    imageId,
    `wadors:${ROOT}/studies/${STUDY}/series/${SERIES}/instances/${SOP}/frames/1`
  );
});

test("the frame request uses exactly the Accept the Cornerstone loader sends", async () => {
  respond = () => new Response("ok", { status: 200 });
  await warmOpeningFrame({
    wadoRsRoot: ROOT,
    studyInstanceUID: STUDY,
    seriesInstanceUID: SERIES,
    sopInstanceUID: SOP,
  });
  const frame = calls.find((call) => call.url.endsWith("/frames/1"));
  assert.ok(frame, "a frame was requested");
  assert.equal(
    frame.accept,
    WADORS_FRAME_ACCEPT,
    "a different Accept would be a different cache entry and warm nothing"
  );
});

test("a known instance count resolves the middle slice with one 1-row QIDO", async () => {
  respond = (url) => (url.includes("/instances?") ? qidoRow(SOP) : new Response("ok", { status: 200 }));
  await warmOpeningFrame({
    wadoRsRoot: ROOT,
    studyInstanceUID: STUDY,
    seriesInstanceUID: SERIES,
    instanceCount: 240,
  });
  const qido = calls.find((call) => call.url.includes("/instances?"));
  assert.ok(qido);
  assert.match(qido.url, /limit=1/);
  assert.match(qido.url, /offset=120/, "stackOpenIndex(240)");
});

test("a stored slice index beats the computed midpoint", async () => {
  respond = (url) => (url.includes("/instances?") ? qidoRow(SOP) : new Response("ok", { status: 200 }));
  await warmOpeningFrame({
    wadoRsRoot: ROOT,
    studyInstanceUID: STUDY,
    seriesInstanceUID: SERIES,
    instanceCount: 240,
    sliceIndex: 37,
  });
  assert.match(calls[0].url, /offset=37/);
});

test("with no slice and no count nothing is requested — that page is the viewer's to own", async () => {
  respond = () => new Response("ok", { status: 200 });
  const imageId = await warmOpeningFrame({
    wadoRsRoot: ROOT,
    studyInstanceUID: STUDY,
    seriesInstanceUID: SERIES,
  });
  assert.equal(imageId, null);
  assert.equal(calls.length, 0);
});

test("a second warm of the same slice is a no-op", async () => {
  respond = () => new Response("ok", { status: 200 });
  const input = {
    wadoRsRoot: ROOT,
    studyInstanceUID: STUDY,
    seriesInstanceUID: SERIES,
    sopInstanceUID: SOP,
  };
  await warmOpeningFrame(input);
  const first = calls.length;
  await warmOpeningFrame(input);
  assert.equal(calls.length, first, "no duplicate requests");
});

test("a failing frame yields null and never throws", async () => {
  respond = (url) => (url.includes("/metadata") ? new Response("ok", { status: 200 }) : null);
  const imageId = await warmOpeningFrame({
    wadoRsRoot: ROOT,
    studyInstanceUID: STUDY,
    seriesInstanceUID: SERIES,
    sopInstanceUID: SOP,
  });
  assert.equal(imageId, null);
});

test("a 404 on the QIDO row stops the warm quietly", async () => {
  respond = () => null;
  const imageId = await warmOpeningFrame({
    wadoRsRoot: ROOT,
    studyInstanceUID: STUDY,
    seriesInstanceUID: SERIES,
    instanceCount: 10,
  });
  assert.equal(imageId, null);
  assert.equal(calls.length, 1, "no metadata or frame after the row missed");
});

test("a trailing slash on the root does not double up in the URL", async () => {
  respond = () => new Response("ok", { status: 200 });
  await warmOpeningFrame({
    wadoRsRoot: "/api/dicomweb/",
    studyInstanceUID: STUDY,
    seriesInstanceUID: SERIES,
    sopInstanceUID: SOP,
  });
  assert.ok(calls.every((call) => !call.url.includes("//studies")));
});

test("warmViewerModules resolves and memoizes without a real module graph", async () => {
  const first = warmViewerModules();
  assert.equal(warmViewerModules(), first, "one warm per page load");
  await first;
});
