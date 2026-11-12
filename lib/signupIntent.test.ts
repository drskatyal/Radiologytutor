import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIGNUP_INTENT_COOKIE,
  SIGNUP_INTENT_HEADER,
  intentFromCookieHeader,
  parseSignupIntent,
  resolveSignupIntent,
} from "./signupIntent.ts";

test("only an explicit student choice is a student sign-up", () => {
  assert.equal(parseSignupIntent("student"), "student");
  assert.equal(parseSignupIntent(" teacher "), "teacher");
  assert.equal(parseSignupIntent("teacher"), "teacher");
  assert.equal(parseSignupIntent(undefined), "teacher");
  assert.equal(parseSignupIntent(null), "teacher");
  assert.equal(parseSignupIntent(""), "teacher");
});

test("admin and super_admin are not public sign-up roles", () => {
  assert.equal(parseSignupIntent("admin"), "teacher");
  assert.equal(parseSignupIntent("super_admin"), "teacher");
  assert.equal(parseSignupIntent("owner"), "teacher");
});

test("the sign-up cookie is the Google channel and the header wins on the same request", () => {
  const cookie = `theme=dark; ${SIGNUP_INTENT_COOKIE}=student; other=1`;
  assert.equal(intentFromCookieHeader(cookie), "student");
  assert.equal(intentFromCookieHeader(`${SIGNUP_INTENT_COOKIE}=admin`), "teacher");
  assert.equal(intentFromCookieHeader(null), "teacher");

  assert.equal(
    resolveSignupIntent({
      cookieHeader: `${SIGNUP_INTENT_COOKIE}=student`,
      headerIntent: "teacher",
    }),
    "teacher"
  );
  assert.equal(
    resolveSignupIntent({
      cookieHeader: `${SIGNUP_INTENT_COOKIE}=teacher`,
      headerIntent: "student",
    }),
    "student"
  );
  assert.equal(
    resolveSignupIntent({
      cookieHeader: `${SIGNUP_INTENT_COOKIE}=student`,
      bodyIntent: "super_admin",
    }),
    "student"
  );
  assert.equal(resolveSignupIntent({ bodyIntent: "super_admin" }), "teacher");
  assert.equal(resolveSignupIntent({ headerIntent: "admin" }), "teacher");
  assert.equal(
    resolveSignupIntent({ cookieHeader: `${SIGNUP_INTENT_COOKIE}=student` }),
    "student"
  );
  assert.equal(SIGNUP_INTENT_HEADER, "x-flowrad-signup-intent");
});
