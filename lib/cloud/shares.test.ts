import { test } from "node:test";
import assert from "node:assert/strict";
import {
  embedSnippet,
  expiryFromChoice,
  isShareToken,
  markupVisible,
  newShareToken,
  shareDicomwebRoot,
  shareStatus,
  visibleTeachingText,
} from "./shares.ts";

test("tokens are random base64url and validate", () => {
  const a = newShareToken();
  assert.equal(isShareToken(a), true);
  assert.notEqual(a, newShareToken());
  assert.equal(isShareToken("../etc/passwd"), false);
  assert.equal(isShareToken("short"), false);
});

test("expiry choices map to times; never is null; unknown throws", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(expiryFromChoice("1d", now), "2026-01-02T00:00:00.000Z");
  assert.equal(expiryFromChoice("never", now), null);
  assert.throws(() => expiryFromChoice("forever", now));
});

test("status: revoked beats expired beats active", () => {
  const now = Date.parse("2026-01-10T00:00:00Z");
  assert.equal(shareStatus({ expiresAt: null, revokedAt: null }, now), "active");
  assert.equal(shareStatus({ expiresAt: "2026-01-09T00:00:00Z", revokedAt: null }, now), "expired");
  assert.equal(shareStatus({ expiresAt: "2026-01-11T00:00:00Z", revokedAt: null }, now), "active");
  assert.equal(
    shareStatus({ expiresAt: "2026-01-09T00:00:00Z", revokedAt: "2026-01-08T00:00:00Z" }, now),
    "revoked"
  );
});

test("unknown mode hides findings, diagnosis, tags and markup", () => {
  const text = { history: "Cough", findings: "RUL mass", diagnosis: "Carcinoma", tags: ["chest"] };
  assert.deepEqual(visibleTeachingText(text, "unknown"), { history: "Cough", findings: "", diagnosis: "", tags: [] });
  assert.deepEqual(visibleTeachingText(text, "findings"), text);
  assert.equal(markupVisible("unknown"), false);
  assert.equal(markupVisible("findings"), true);
});

test("share DICOMweb root carries the token in the path; embeds use /embed", () => {
  assert.equal(shareDicomwebRoot("abc"), "/api/dicomweb/s/abc");
  assert.match(embedSnippet("https://viewer.flowrad.ai/", "tok"), /src="https:\/\/viewer\.flowrad\.ai\/embed\/tok"/);
});
