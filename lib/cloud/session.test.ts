import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIdTokenClaims, devSignInEnabled, devUserId, signSession, verifySession } from "./session.ts";

const env = { NODE_ENV: "test", SESSION_SECRET: "s".repeat(32) } as unknown as NodeJS.ProcessEnv;

test("a signed session verifies and round-trips the user", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const cookie = signSession({ id: "u1", email: "a@b.co", name: "A" }, now, env);
  assert.deepEqual(verifySession(cookie, now + 1000, env), { id: "u1", email: "a@b.co", name: "A" });
});

test("tampered, foreign-key, or expired sessions are rejected", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const cookie = signSession({ id: "u1", email: "a@b.co" }, now, env);
  const [body, mac] = cookie.split(".");
  const forged = Buffer.from(JSON.stringify({ id: "admin", email: "x@y.z", exp: 9e9 })).toString("base64url");
  assert.equal(verifySession(`${forged}.${mac}`, now, env), null);
  assert.equal(verifySession(`${body}.${mac}x`, now, env), null);
  assert.equal(verifySession(cookie, now, { ...env, SESSION_SECRET: "t".repeat(32) } as NodeJS.ProcessEnv), null);
  assert.equal(verifySession(cookie, now + 15 * 86_400_000, env), null);
  assert.equal(verifySession("", now, env), null);
});

test("dev sign-in is never available on Cloud Run", () => {
  assert.equal(devSignInEnabled({ VIEWER_DEV_SIGN_IN: "1", K_SERVICE: "flowrad-viewer" } as unknown as NodeJS.ProcessEnv), false);
  assert.equal(devSignInEnabled({ VIEWER_DEV_SIGN_IN: "1" } as unknown as NodeJS.ProcessEnv), true);
  assert.equal(devSignInEnabled({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv), false);
  assert.equal(devUserId("A@b.co "), devUserId("a@b.co"));
  assert.match(devUserId("a@b.co"), /^dev-[0-9a-f]{24}$/);
});

test("ID token claim checks", () => {
  const now = 1_800_000_000;
  const good = { aud: "proj", iss: "https://securetoken.google.com/proj", sub: "uid", exp: now + 600, iat: now - 10, email: "a@b.co" };
  assert.equal(checkIdTokenClaims(good, "proj", now), null);
  assert.equal(checkIdTokenClaims({ ...good, aud: "other" }, "proj", now), "wrong audience");
  assert.equal(checkIdTokenClaims({ ...good, iss: "https://evil" }, "proj", now), "wrong issuer");
  assert.equal(checkIdTokenClaims({ ...good, exp: now - 100 }, "proj", now), "expired");
  assert.equal(checkIdTokenClaims({ ...good, email: undefined }, "proj", now), "account has no email");
});
