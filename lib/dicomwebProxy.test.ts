import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WADORS_FRAME_ACCEPT,
  responseCacheControl,
  upstreamAccept,
  varyHeaderForDicomwebPath,
} from "./dicomwebProxy.ts";

const FRAME =
  "studies/1.2.3/series/4.5.6/instances/7.8.9/frames/1";

test("frame cache headers are success-only so a 400 cannot stick", () => {
  assert.match(responseCacheControl(FRAME, 200) ?? "", /immutable/);
  assert.equal(responseCacheControl(FRAME, 400), null);
  assert.equal(responseCacheControl(FRAME, 404), null);
  assert.equal(responseCacheControl(FRAME, 503), null);
});

test("frame and rendered bodies vary on Accept", () => {
  assert.equal(varyHeaderForDicomwebPath(FRAME), "Accept");
  assert.equal(
    varyHeaderForDicomwebPath("studies/1.2.3/series/4.5/instances/7/rendered"),
    "Accept"
  );
  assert.equal(varyHeaderForDicomwebPath("studies/1.2.3"), null);
});

test("a bare octet-stream frame Accept is rewritten to the loader media type", () => {
  assert.equal(upstreamAccept(FRAME, "application/octet-stream"), WADORS_FRAME_ACCEPT);
  assert.equal(upstreamAccept(FRAME, null), WADORS_FRAME_ACCEPT);
  assert.match(WADORS_FRAME_ACCEPT, /multipart\/related/);
  assert.match(WADORS_FRAME_ACCEPT, /transfer-syntax=\*/);
  const loader = "multipart/related; type=application/octet-stream; transfer-syntax=*";
  assert.equal(upstreamAccept(FRAME, loader), loader);
});

test("rendered thumbnails ask Orthanc for jpeg unless the client named one", () => {
  const rendered = "studies/1.2.3/series/4.5/instances/7/rendered";
  assert.equal(
    upstreamAccept(rendered, "image/avif,image/webp,image/*,*/*;q=0.8"),
    "image/jpeg"
  );
  assert.equal(upstreamAccept(rendered, null), "image/jpeg");
  assert.equal(upstreamAccept(rendered, "image/png"), "image/png");
});
