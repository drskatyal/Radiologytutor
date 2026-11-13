import { test } from "node:test";
import assert from "node:assert/strict";
import { hasAuthCookie, memoisedOwnership } from "./studyAccess";
import { createTtlMemo } from "./ttlMemo";

test("auth cookies are recognised by name; others are not", () => {
  assert.equal(hasAuthCookie("flowrad_demo=abc.def"), true);
  assert.equal(hasAuthCookie("x=1; better-auth.session_token=t"), true);
  assert.equal(hasAuthCookie("__Secure-better-auth.session_token=t"), true);
  assert.equal(hasAuthCookie("flowrad_consent=1; theme=dark"), false);
  assert.equal(hasAuthCookie(""), false);
});

test("ownership memo never caches a no: a study created a moment later is readable", async () => {
  const memo = createTtlMemo<boolean>({ ttlMs: 60_000, maxEntries: 10 });
  let exists = false;
  let lookups = 0;
  const lookup = async () => {
    lookups++;
    return exists;
  };
  assert.equal(await memoisedOwnership(memo, "k", lookup), false);
  exists = true; // the case is saved, the Study record now exists
  assert.equal(await memoisedOwnership(memo, "k", lookup), true);
  assert.equal(await memoisedOwnership(memo, "k", lookup), true);
  assert.equal(lookups, 2, "the yes is cached, the no was not");
});
