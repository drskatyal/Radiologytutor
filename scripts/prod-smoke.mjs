#!/usr/bin/env node
// Production smoke test for the free viewer (/viewer) on a deployed site.
//
//   node scripts/prod-smoke.mjs <base-url> <study-dir> [--expect-commit <sha>] [--wait-deploy-s 900]
//
// Opens <base-url>/viewer in Chromium, drops a synthetic study (no patient
// data: scripts/make-test-ct.py) and waits for the first image to be drawn.
// Records what the deployment actually serves: every JS chunk's status,
// content-type / content-encoding / cache headers and size, console errors,
// failed requests and the workers the page starts. Then fetches each chunk
// the page used, with and without compression, and checks the body is the
// complete chunk (it parses, and registers the chunk id its name says).
//
// --expect-commit polls /api/version until the deployed commit is that commit
// or a later one that contains it (Railway may go straight to a newer push),
// up to --wait-deploy-s seconds. Containment is checked with git in the
// checkout, fetching --deploy-branch (default: the integration branch).
//
// Writes a Markdown report to stdout (and $GITHUB_STEP_SUMMARY when set);
// exits non-zero when the study did not paint or a chunk is broken.

import { chromium, firefox, webkit } from "playwright";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const [base, studyDir] = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
if (!base || !studyDir) {
  console.error("usage: prod-smoke.mjs <base-url> <study-dir> [--expect-commit sha] [--wait-deploy-s 900]");
  process.exit(2);
}
const root = base.replace(/\/$/, "");
const expectCommit = arg("--expect-commit", null);
const waitDeployS = Number(arg("--wait-deploy-s", 900));
const deployBranch = arg("--deploy-branch", "claude/epic-noether-3nvcbf");
const lines = [];
const out = (s = "") => lines.push(s);

async function version() {
  try {
    const res = await fetch(`${root}/api/version`, { headers: { "cache-control": "no-cache" } });
    return res.ok ? await res.json() : { error: res.status };
  } catch (error) {
    return { error: String(error) };
  }
}

const git = (...args) => execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
let fetched = false;
/** The deployed commit is the expected one, or a later one on the branch that contains it. */
function containsExpected(commit) {
  const deployedSha = String(commit ?? "");
  if (!expectCommit || !deployedSha) return !expectCommit;
  if (deployedSha.startsWith(expectCommit.slice(0, 7))) return true;
  try {
    if (!fetched) {
      git("fetch", "-q", "--depth=200", "origin", deployBranch);
      fetched = true;
    }
    git("merge-base", "--is-ancestor", expectCommit, deployedSha);
    return true;
  } catch {
    return false; // not an ancestor, or the deployed commit is unknown here
  }
}

let deployed = await version();
if (expectCommit) {
  const deadline = Date.now() + waitDeployS * 1000;
  while (!containsExpected(deployed.commit) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    deployed = await version();
  }
}
out(`### Free viewer production smoke (${process.env.PROD_SMOKE_BROWSER || "chromium"}): ${root}/viewer`);
out("");
const deployOk = containsExpected(deployed.commit);
out(`Deployed: \`${JSON.stringify(deployed)}\`${expectCommit ? ` (expected ${expectCommit.slice(0, 7)} or a later commit containing it: ${deployOk ? "yes" : "no"})` : ""}`);


// PROD_SMOKE_BROWSER=chromium|firefox|webkit (WebKit is Safari's engine).
const engineName = process.env.PROD_SMOKE_BROWSER || "chromium";
const engine = { chromium, firefox, webkit }[engineName];
const browser = await engine.launch(
  engineName === "chromium"
    ? {
        executablePath: process.env.PW_CHROMIUM_PATH || undefined,
        args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
      }
    : {}
);
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
const failed = [];
const workers = [];
const chunks = new Map();
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") consoleErrors.push(`${m.type()}: ${m.text().slice(0, 300)}`);
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 300)}`));
page.on("requestfailed", (r) => failed.push(`${r.url()} — ${r.failure()?.errorText}`));
page.on("worker", (w) => workers.push(w.url()));
page.on("response", async (res) => {
  const url = res.url();
  if (!/\/_next\/static\/.*\.js(\?|$)/.test(url)) return;
  const h = res.headers();
  let size = null;
  try {
    size = (await res.body()).length;
  } catch {
    /* body unavailable (redirect / aborted) */
  }
  chunks.set(url, {
    status: res.status(),
    type: h["content-type"],
    encoding: h["content-encoding"] ?? "",
    length: h["content-length"] ?? "",
    cache: h["cache-control"] ?? "",
    coep: h["cross-origin-embedder-policy"] ?? "",
    corp: h["cross-origin-resource-policy"] ?? "",
    csp: h["content-security-policy"] ?? "",
    size,
    fromWorker: !res.frame(),
  });
});

await page.goto(`${root}/viewer`, { waitUntil: "load" });
const docHeaders = (await page.request.get(`${root}/viewer`)).headers();
await page.waitForTimeout(3000);
// Folder input where the browser supports it in automation, else the plain
// "Choose files" input with every file of the study.
try {
  await page.locator("input[type=file][webkitdirectory]").setInputFiles(studyDir);
} catch {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.name.startsWith(".") ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
    );
  const files = walk(studyDir);
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(files);
}
let painted = false;
let failure = null;
try {
  await page.waitForFunction(
    () =>
      performance.getEntriesByType("mark").some((m) => m.name.startsWith("radlearn:first-rendered")) ||
      /Loading chunk|Error:|could not/i.test(document.body.innerText),
    null,
    { timeout: 60_000 }
  );
  painted = await page.evaluate(() =>
    performance.getEntriesByType("mark").some((m) => m.name.startsWith("radlearn:first-rendered"))
  );
  if (!painted) failure = (await page.locator("body").innerText()).match(/.*(Loading chunk|Error:|could not).*/i)?.[0] ?? "error";
} catch {
  failure = "timed out waiting for the first image (60 s)";
}
await page.screenshot({ path: `prod-smoke-${engineName}${process.env.PROD_SMOKE_TAG ? `-${process.env.PROD_SMOKE_TAG}` : ""}.png` });
await browser.close();

out("");
out(`**First image drawn:** ${painted ? "yes" : `NO — ${failure}`}`);
out("");
out("Document headers: " + ["content-security-policy", "cross-origin-embedder-policy", "cross-origin-opener-policy", "cache-control"].map((k) => `${k}=\`${docHeaders[k] ?? ""}\``).join(", "));
out("");
out(`Workers started: ${workers.length ? workers.map((w) => `\`${w.split("/").pop()}\``).join(", ") : "none"}`);
out("");

// Re-fetch every chunk the page used: is the body the whole chunk?
const broken = [];
out("| chunk | status | type | encoding | header len | browser body | gzip body | identity body | parses + registers |");
out("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const [url, c] of chunks) {
  const name = url.split("/").pop();
  const idMatch = name.match(/^(\d+)\./);
  const bodies = {};
  for (const [label, enc] of [["gzip", "gzip, deflate, br"], ["identity", "identity"]]) {
    try {
      const res = await fetch(url, { headers: { "accept-encoding": enc } });
      bodies[label] = await res.text();
    } catch (error) {
      bodies[label] = null;
    }
  }
  let verdict = "—";
  const body = bodies.gzip ?? bodies.identity;
  if (body != null && idMatch) {
    try {
      const sandbox = {};
      sandbox.self = sandbox;
      vm.runInNewContext(body, sandbox, { timeout: 5000 });
      const registered = (sandbox.webpackChunk_N_E ?? []).some(
        (entry) => Array.isArray(entry?.[0]) && entry[0].map(String).includes(idMatch[1])
      );
      verdict = registered ? "ok" : "PARSES, DOES NOT REGISTER";
    } catch (error) {
      verdict = `${error?.name === "SyntaxError" ? "SYNTAX" : "THROWS"}: ${String(error?.message).slice(0, 80)}`;
    }
  } else if (body != null) {
    verdict = "runtime/entry (not checked)";
  }
  if (c.status !== 200 || verdict.startsWith("PARSES") || verdict.startsWith("SYNTAX") || (bodies.gzip != null && bodies.identity != null && bodies.gzip.length !== bodies.identity.length)) {
    broken.push(name);
  }
  out(
    `| ${name}${c.fromWorker ? " (worker)" : ""} | ${c.status} | ${c.type ?? ""} | ${c.encoding} | ${c.length} | ${c.size ?? "?"} | ${bodies.gzip?.length ?? "ERR"} | ${bodies.identity?.length ?? "ERR"} | ${verdict} |`
  );
}
out("");
out(`Console errors / warnings (${consoleErrors.length}):`);
for (const e of consoleErrors.slice(0, 40)) out(`- \`${e.replace(/`/g, "'")}\``);
out("");
out(`Failed requests (${failed.length}):`);
for (const f of failed.slice(0, 40)) out(`- \`${f}\``);

const report = lines.join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
process.exit(painted && broken.length === 0 && deployOk ? 0 : 1);
