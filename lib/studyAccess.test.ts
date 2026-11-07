import { test } from "node:test";
import assert from "node:assert/strict";
import { hasAuthCookie } from "./studyAccess";

test("auth cookies are recognised by name; others are not", () => {
  assert.equal(hasAuthCookie("flowrad_demo=abc.def"), true);
  assert.equal(hasAuthCookie("x=1; better-auth.session_token=t"), true);
  assert.equal(hasAuthCookie("__Secure-better-auth.session_token=t"), true);
  assert.equal(hasAuthCookie("flowrad_consent=1; theme=dark"), false);
  assert.equal(hasAuthCookie(""), false);
});
