import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = "deploy/gcp/resolve-deploy-env.sh";

function bash(body: string, extra: Record<string, string> = {}): { stdout: string; stderr: string } {
  const source = [
    "unset DEMO_AUTH_ENABLED DEMO_AUTH_MAX_ROLE GEMINI_LIVE_MODEL GEMINI_MODEL ALLOW_STALE_GEMINI_LIVE_MODEL",
    `source ${script}`,
    body,
  ].join("\n");
  const result = spawnSync("bash", ["-c", source], {
    encoding: "utf8",
    env: { ...process.env, ...extra },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || "bash failed");
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("fresh service defaults match production, and a live value is kept when unset", () => {
  const fresh = bash(`
    printf '%s\\n' "$(resolve_deploy_env DEMO_AUTH_ENABLED 1 '')"
    printf '%s\\n' "$(resolve_deploy_env DEMO_AUTH_MAX_ROLE author '')"
    printf '%s\\n' "$(resolve_deploy_env GEMINI_MODEL gemini-3.8-flash '')"
    printf '%s\\n' "$(resolve_deploy_env GEMINI_LIVE_MODEL gemini-3.8-live '')"
  `);
  assert.deepEqual(fresh.stdout.trim().split("\n"), [
    "1",
    "author",
    "gemini-3.8-flash",
    "gemini-3.8-live",
  ]);

  const kept = bash(`
    printf '%s\\n' "$(resolve_deploy_env DEMO_AUTH_ENABLED 1 1)"
    printf '%s\\n' "$(resolve_deploy_env DEMO_AUTH_MAX_ROLE author author)"
    printf '%s\\n' "$(resolve_deploy_env GEMINI_LIVE_MODEL gemini-3.8-live gemini-3.8-live)"
    printf '%s\\n' "$(resolve_deploy_env GEMINI_MODEL gemini-3.8-flash gemini-3.8-flash)"
  `);
  assert.deepEqual(kept.stdout.trim().split("\n"), [
    "1",
    "author",
    "gemini-3.8-live",
    "gemini-3.8-flash",
  ]);
});

test("an unset shell does not replace a live model, and the retired Live model is refused", () => {
  const keptNewer = bash(`
    printf '%s' "$(resolve_deploy_env GEMINI_LIVE_MODEL gemini-3.8-live gemini-4-live)"
  `);
  assert.equal(keptNewer.stdout, "gemini-4-live");

  const refused = bash(
    `
    export GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio
    resolved="$(resolve_deploy_env GEMINI_LIVE_MODEL gemini-3.8-live gemini-3.8-live)"
    printf '%s' "$(guard_gemini_live_model "$resolved" gemini-3.8-live)"
    `,
    {}
  );
  assert.equal(refused.stdout, "gemini-3.8-live");
  assert.match(refused.stderr, /refusing stale/);

  const freshStale = bash(`
    export GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio
    resolved="$(resolve_deploy_env GEMINI_LIVE_MODEL gemini-3.8-live '')"
    printf '%s' "$(guard_gemini_live_model "$resolved" '')"
  `);
  assert.equal(freshStale.stdout, "gemini-3.8-live");
  assert.match(freshStale.stderr, /retired/);
});

test("service JSON keeps plain env and skips secret refs", () => {
  const result = bash(`
    printf '%s' '{"spec":{"template":{"spec":{"containers":[{"env":[{"name":"DEMO_AUTH_ENABLED","value":"1"},{"name":"DEMO_AUTH_MAX_ROLE","value":"author"},{"name":"GEMINI_LIVE_MODEL","value":"gemini-3.8-live"},{"name":"GEMINI_API_KEY","valueFrom":{"secretKeyRef":{"name":"GEMINI_API_KEY"}}}]}]}}}}' | cloud_run_env_tsv
  `);
  assert.match(result.stdout, /^DEMO_AUTH_ENABLED\t1$/m);
  assert.match(result.stdout, /^DEMO_AUTH_MAX_ROLE\tauthor$/m);
  assert.match(result.stdout, /^GEMINI_LIVE_MODEL\tgemini-3\.8-live$/m);
  assert.equal(result.stdout.includes("GEMINI_API_KEY"), false);
});
