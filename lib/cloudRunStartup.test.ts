import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { ENV_SCHEMA, PROVISIONAL_GCS_BUCKET_ENV, ProductionEnvError, validateProductionEnv } from "./envSchema";
import { buildRuntimeEnv } from "../scripts/build-runtime-env.mjs";
import { GET, HEAD } from "../app/api/healthz/route";

// Public synthetic strings only. No credential discovery and no network.
function validEnv(): Record<string, string> {
  return {
    NODE_ENV: "production", DICOMWEB_BACKEND: "healthcare",
    HEALTHCARE_PROJECT: "synthetic-project", HEALTHCARE_LOCATION: "europe-west2",
    HEALTHCARE_DATASET: "synthetic-dataset", HEALTHCARE_DICOM_STORE: "synthetic-store",
    MONGODB_DB: "synthetic", MONGODB_URI: "mongodb://127.0.0.1:1/synthetic",
    BETTER_AUTH_URL: "https://synthetic.example", BETTER_AUTH_SECRET: "synthetic-auth-only-never-a-real-secret",
    TRUSTED_PROXY_SECRET: "synthetic-proxy-only-never-a-real-secret",
    [PROVISIONAL_GCS_BUCKET_ENV]: "synthetic-private-bucket",
  };
}

test("B production validation accepts C2/PACS configuration without optional providers or legacy backends", t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Network is forbidden"); });
  assert.doesNotThrow(() => validateProductionEnv(validEnv()));
  assert.doesNotThrow(() => validateProductionEnv({ ...validEnv(), PORT: "9090", FRAME_CACHE_WAIT_MS: "0", GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic" }));
  assert.equal(fetch.mock.calls.length, 0);
});

test("B every required production variable independently fails closed when absent or blank", () => {
  for (const [name, spec] of Object.entries(ENV_SCHEMA)) {
    if (!spec.requiredInProduction) continue;
    for (const value of [undefined, "", "  "]) {
      const env: Record<string, string | undefined> = { ...validEnv(), [name]: value };
      assert.throws(() => validateProductionEnv(env), error => error instanceof ProductionEnvError && error.missing.includes(name), name);
    }
  }
});

test("B malformed production configuration reports variable names, never values", () => {
  const candidates: Array<[string, string]> = [
    ["NODE_ENV", "test"], ["DICOMWEB_BACKEND", "orthanc"], ["HEALTHCARE_PROJECT", "project/path"],
    ["HEALTHCARE_LOCATION", "https://synthetic.example"], ["HEALTHCARE_DATASET", "bad?query"], ["HEALTHCARE_DICOM_STORE", "bad#fragment"],
    ["MONGODB_DB", "bad/name"], ["MONGODB_URI", "synthetic-invalid-secret-value"],
    ["BETTER_AUTH_URL", "https://user:synthetic-private-value@synthetic.example"], ["BETTER_AUTH_URL", "http://external.example"],
    ["BETTER_AUTH_URL", "https://synthetic.example/a"], ["BETTER_AUTH_URL", "https://synthetic.example?x=1"],
    [PROVISIONAL_GCS_BUCKET_ENV, "gs://synthetic-bucket"], ["PORT", "0"], ["PORT", "65536"], ["PORT", "8080oops"],
    ["GEMINI_TIMEOUT_MS", "NaN"], ["GEMINI_TIMEOUT_MS", "0"], ["VOICE_LATENCY_BUDGET_MS", "-1"],
    ["FRAME_CACHE_WAIT_MS", "1.5"], ["FRAME_CACHE_WAIT_MS", "9007199254740992"],
    ["DEMO_AUTH_ENABLED", "yes"], ["DEMO_AUTH_MAX_ROLE", "admin"],
  ];
  for (const [name, value] of candidates) {
    assert.throws(() => validateProductionEnv({ ...validEnv(), [name]: value }), error => {
      assert.ok(error instanceof ProductionEnvError);
      assert.ok(error.invalid.includes(name), `${name} should be rejected`);
      assert.doesNotMatch(error.message, /synthetic-invalid-secret-value|synthetic-private-value|user:/);
      return true;
    });
  }
});

test("B OAuth fields are required together; localhost origins remain usable for local production checks", () => {
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
    assert.throws(() => validateProductionEnv({ ...validEnv(), [name]: "synthetic" }), error => error instanceof ProductionEnvError && error.missing.includes(name === "GOOGLE_CLIENT_ID" ? "GOOGLE_CLIENT_SECRET" : "GOOGLE_CLIENT_ID"));
  }
  assert.doesNotThrow(() => validateProductionEnv({ ...validEnv(), BETTER_AUTH_URL: "http://127.0.0.1:3102" }));
});

test("B compiled production preload exits before server code, hides values and honors PORT", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "radlearn-runtime-"));
  try {
    const entry = buildRuntimeEnv(dir);
    const run = (env: Record<string, string>) => spawnSync(process.execPath, ["--require", entry, "-e", "console.log('SERVER_REACHED:' + process.env.PORT)"], { encoding: "utf8", env: { NODE_ENV: "production", ...env }, timeout: 10_000 });
    const missing = run({ NODE_ENV: "production", BETTER_AUTH_SECRET: "synthetic-private-value" });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /Missing required variables:.*DICOMWEB_BACKEND/);
    assert.doesNotMatch(missing.stderr, /synthetic-private-value/);
    const malformed = run({ ...validEnv(), MONGODB_URI: "synthetic-private-value" });
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stdout, "");
    assert.match(malformed.stderr, /Invalid variables: MONGODB_URI/);
    assert.doesNotMatch(malformed.stderr, /synthetic-private-value/);
    const wrongMode = run({ ...validEnv(), NODE_ENV: "test", K_SERVICE: "synthetic" });
    assert.equal(wrongMode.status, 1); // no test/dev flag can bypass this entry point
    for (const [port, expected] of [[undefined, "8080"], ["9090", "9090"]]) {
      const result = run({ ...validEnv(), ...(port ? { PORT: port } : {}) });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), `SERVER_REACHED:${expected}`);
      assert.equal(result.stderr, "");
    }
    const compiled = readFileSync(path.join(dir, "envSchema.cjs"), "utf8");
    assert.doesNotMatch(compiled, /synthetic-private-value|synthetic-auth-only|google-auth-library|node:fs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B liveness GET/HEAD is constant, uncached and does not call providers or log", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Network is forbidden"); });
  const logs = (["log", "info", "warn", "error", "debug"] as const).map(name => t.mock.method(console, name, () => undefined));
  const response = GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(HEAD().status, 200);
  assert.equal(await HEAD().text(), "");
  assert.equal(fetch.mock.calls.length, 0);
  assert.equal(logs.reduce((n, log) => n + log.mock.calls.length, 0), 0);
});

test("B Docker static contract: checked production build, non-root standalone runner, injected PORT, no secret args", () => {
  const docker = readFileSync("Dockerfile", "utf8");
  assert.equal((docker.match(/^FROM /gm) ?? []).length, 3);
  assert.equal((docker.match(/^FROM node:24-bookworm-slim AS /gm) ?? []).length, 3);
  assert.match(docker, /^RUN npm ci$/m);
  assert.match(docker, /^RUN npm run build$/m);
  assert.match(docker, /^ENV PORT=8080$/m);
  assert.match(docker, /^ENV HOSTNAME=0\.0\.0\.0$/m);
  assert.match(docker, /^USER nextjs$/m);
  assert.match(docker, /^EXPOSE 8080$/m);
  assert.match(docker, /CMD \["node", "--require", "\.\/runtime\/startup-check.cjs", "server.js"\]/);
  assert.doesNotMatch(docker, /COPY \. \.|RAILWAY_|fetch-voice-model|carry-static|docker push/);
  assert.deepEqual(docker.match(/^ARG .*$/gm), ['ARG GIT_SHA=""']);
  assert.doesNotMatch(docker, /^(?:ARG|ENV) .*?(?:SECRET|API_KEY|MONGODB_URI|GOOGLE_APPLICATION_CREDENTIALS)/m);
  const runtime = docker.split("AS runner")[1];
  assert.doesNotMatch(runtime, /npm ci|npm install|COPY .*node_modules/);
  for (const line of docker.split("\n").filter(line => line.startsWith("COPY ") && !line.includes("--from="))) {
    for (const file of line.split(/\s+/).slice(1, -1)) assert.ok(existsSync(file), `Docker COPY source missing: ${file}`);
  }
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  assert.equal(scripts.postbuild, "node scripts/build-runtime-env.mjs");
  assert.match(scripts.start, /--require \.\/.next\/standalone\/runtime\/startup-check.cjs/);
});

test("B Docker context excludes credentials and test state; Railway configuration is absent and probes use healthz", () => {
  const ignored = new Set(readFileSync(".dockerignore", "utf8").split("\n"));
  for (const pattern of [".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*credentials*.json", "**/*service-account*.json", "**/.aws", "**/.config", "**/.gcloud", "**/.ssh", "**/.npmrc", ".radlearn-tmp", "test-results", "playwright-report", "data", "deploy"]) assert.ok(ignored.has(pattern), pattern);
  for (const file of ["railway.json", "railway.toml", "nixpacks.toml"]) assert.equal(existsSync(file), false);
  assert.match(readFileSync("deploy/gcp/deploy-app.sh", "utf8"), /httpGet.path=\/api\/healthz/);
  assert.match(readFileSync("deploy/gcp/terraform/run.tf", "utf8"), /path = "\/api\/healthz"/);
  assert.match(readFileSync("CLAUDE.md", "utf8"), /GCP Cloud Run, owned by GCP Admin, is the only deploy target/);
});

test("B desktop update defaults use the stable public Cloud Run front door, retaining GitHub fallback", () => {
  const config = JSON.parse(readFileSync("desktop/src-tauri/tauri.conf.json", "utf8"));
  assert.equal(config.plugins.updater.endpoints[0], "https://learn.flowrad.ai/api/desktop/update");
  assert.ok(config.plugins.updater.endpoints.some((url: string) => url.startsWith("https://github.com/")));
  const source = readFileSync("desktop/src-tauri/src/updates.rs", "utf8");
  assert.match(source, /None => "https:\/\/learn\.flowrad\.ai"/);
  assert.doesNotMatch(source, /railway\.app/);
});
