import { strict as assert } from "node:assert";
import { test } from "node:test";
import { redactIdentifiers, safeErrorText } from "../packages/viewer-core/src/safeLog";

// The viewer must never print patient data. A Cornerstone loader rejection is
// `{ error, dataSet }` and the dataSet holds the whole header.

test("a loader rejection prints the message only, never the dataset", () => {
  const rejection = {
    error: new Error("Failed to decode 1.2.826.0.1.3680043.10.1078.42.1234"),
    dataSet: { string: () => "DOE^JANE", byteArray: new Uint8Array(10) },
  };
  const text = safeErrorText(rejection);
  assert.equal(text, "Error: Failed to decode [uid]");
  assert.doesNotMatch(text, /DOE|JANE|dataSet/);
});

test("UIDs are masked wherever they appear", () => {
  assert.equal(redactIdentifiers("series 1.2.840.113619.2.55.3 at 2.5mm"), "series [uid] at 2.5mm");
  assert.equal(redactIdentifiers("version 1.2.3"), "version 1.2.3");
});

test("unknown shapes fall back to a constant", () => {
  assert.equal(safeErrorText({ dataSet: {} }), "unknown error");
  assert.equal(safeErrorText(null), "unknown error");
  assert.equal(safeErrorText("plain"), "plain");
});
