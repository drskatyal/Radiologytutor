import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_SYNTAXES,
  acceptsAnySyntax,
  frameAcceptFor,
  isTranscodeRefusal,
  preferredFrameSyntax,
  seriesKeyForFramePath,
} from "./frameTransfer";

test("Cloud Healthcare defaults to lossless JPEG-LS; Orthanc to as-stored", () => {
  assert.equal(preferredFrameSyntax("healthcare", undefined).name, "jls");
  assert.equal(preferredFrameSyntax("orthanc", undefined).name, "original");
});

test("the env var wins, and junk falls back to the backend default", () => {
  assert.equal(preferredFrameSyntax("orthanc", "jls").name, "jls");
  assert.equal(preferredFrameSyntax("healthcare", " HTJ2K ").name, "htj2k");
  assert.equal(preferredFrameSyntax("healthcare", "original").name, "original");
  assert.equal(preferredFrameSyntax("healthcare", "lossy-please").name, "jls");
});

test("Accept headers follow DICOM PS3.18 for frames", () => {
  assert.equal(
    frameAcceptFor(FRAME_SYNTAXES.jls),
    'multipart/related; type="image/jls"; transfer-syntax=1.2.840.10008.1.2.4.80'
  );
  assert.equal(
    frameAcceptFor(FRAME_SYNTAXES.original),
    "multipart/related; type=application/octet-stream; transfer-syntax=*"
  );
});

test("only the loader's 'whatever is stored' request is upgraded", () => {
  assert.equal(acceptsAnySyntax("multipart/related; type=application/octet-stream; transfer-syntax=*"), true);
  assert.equal(acceptsAnySyntax(null), true);
  assert.equal(acceptsAnySyntax("multipart/related; type=application/octet-stream"), true);
  assert.equal(
    acceptsAnySyntax("multipart/related; type=application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1"),
    false,
    "a caller that names a syntax gets exactly that"
  );
});

test("a transcode refusal is distinguished from a missing frame", () => {
  for (const s of [400, 406, 415, 501]) assert.equal(isTranscodeRefusal(s), true, String(s));
  for (const s of [401, 403, 404, 500, 503]) assert.equal(isTranscodeRefusal(s), false, String(s));
});

test("the fallback memo is per series", () => {
  assert.equal(
    seriesKeyForFramePath("studies/1.2/series/3.4/instances/5.6/frames/1"),
    "1.2/3.4"
  );
  assert.equal(seriesKeyForFramePath("studies/1.2/series/3.4/metadata"), null);
});
