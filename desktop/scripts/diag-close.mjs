#!/usr/bin/env node
// DIAGNOSTIC ONLY (scratch branch): what the macOS tree holds after a study
// closes, per process and per footprint category, over time and over two
// open/close rounds. Usage: node diag-close.mjs <app> <study> <label> [hold-s]
// Extra env (FLOWRAD_DIAG_*) is passed through to the app.
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";

const [binary, study, label = "run", holdArg = "40"] = process.argv.slice(2);
const hold = Number(holdArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const benchEnv = (vars) => Object.fromEntries(Object.entries(vars).flatMap(([k, v]) => [[`FLOWRAD_${k}`, v], [`RADLEARN_${k}`, v]]));

function etimeSeconds(t) {
  const [d, rest] = t.includes("-") ? t.split("-") : ["0", t];
  return rest.split(":").map(Number).reduce((a, n) => a * 60 + n, 0) + Number(d) * 86400;
}
function topMb(v) {
  const m = /^([\d.]+)([KMGB]?)/.exec(v ?? "");
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2] === "G" ? n * 1024 : m[2] === "K" ? n / 1024 : m[2] === "B" ? n / 1048576 : n;
}
function tree(pid) {
  const rows = [];
  for (const line of execFileSync("ps", ["-axo", "pid=,ppid=,etime=,rss=,comm="]).toString().split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), age: etimeSeconds(m[3]), rssKb: Number(m[4]), comm: m[5] });
  }
  const app = rows.find((r) => r.pid === pid);
  if (!app) return [];
  const out = [app];
  for (const r of rows) if (r.pid !== pid && /com\.apple\.WebKit\./.test(r.comm) && r.age <= app.age + 2) out.push(r);
  const fp = new Map();
  const args = ["-l", "1", "-s", "0", "-stats", "pid,mem"];
  for (const r of out) args.push("-pid", String(r.pid));
  for (const line of execFileSync("top", args, { encoding: "utf8" }).split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (m) fp.set(Number(m[1]), topMb(m[2]));
  }
  const kind = (r) => (r.pid === pid ? "app" : /WebContent/.test(r.comm) ? "renderer" : /GPU/.test(r.comm) ? "gpu" : /Networking/.test(r.comm) ? "net" : path.basename(r.comm));
  return out.map((r) => ({ pid: r.pid, type: kind(r), mb: Math.round((fp.get(r.pid) ?? r.rssKb / 1024) * 10) / 10 }));
}
function cats(pid) {
  const mb = (v) => {
    const m = /^([\d.]+)\s*([KMG]?)B$/.exec(v.trim());
    return m ? Number(m[1]) * { "": 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 }[m[2]] : NaN;
  };
  try {
    const out = execFileSync("sudo", ["-n", "/usr/bin/footprint", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 });
    const c = {};
    for (const line of out.split("\n")) {
      const m = /^\s*([\d.]+ ?[KMG]?B)\s+([\d.]+ ?[KMG]?B)\s+([\d.]+ ?[KMG]?B)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (m && m[5] !== "TOTAL") c[m[5]] = Math.round(mb(m[1]) * 10) / 10;
    }
    return c;
  } catch {
    return null;
  }
}
function delta(a, b) {
  if (!a || !b) return "n/a";
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const d = [...keys].map((k) => [k, Math.round(((b[k] ?? 0) - (a[k] ?? 0)) * 10) / 10]).filter(([, v]) => Math.abs(v) >= 0.3);
  d.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  return d.slice(0, 10).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(", ") || "-";
}
function sample(pid) {
  const procs = tree(pid);
  const c = {};
  for (const p of procs) if (["app", "renderer", "gpu"].includes(p.type)) c[p.type] = cats(p.pid);
  return { total: Math.round(procs.reduce((n, p) => n + p.mb, 0)), procs, cats: c };
}
const line = (s) => s.procs.map((p) => `${p.type} ${p.mb}`).join(", ");

// 1. Baseline: the empty app, 10 s.
const empty = spawn(binary, [], { stdio: "ignore", env: process.env });
await sleep(10_000);
const base = sample(empty.pid);
empty.kill("SIGKILL");
await sleep(2000);
console.log(`[${label}] baseline ${base.total} MB (${line(base)})`);
for (const k of ["app", "renderer"]) console.log(`[${label}] baseline ${k} categories: ${JSON.stringify(base.cats[k])}`);

// 2. Two open / close rounds.
const child = spawn(binary, [study], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ...benchEnv({ BENCH: "1", BENCH_VIEW: "openclose", BENCH_CLOSE_AFTER_MS: String(hold * 1000), LEAK_ROUNDS: "2" }) },
});
const reports = [];
let partial = "";
child.stdout.on("data", (d) => {
  const lines = (partial + d).split("\n");
  partial = lines.pop() ?? "";
  for (const l of lines) {
    if (/^(FLOWRAD|RADLEARN)_BENCH /.test(l)) {
      try {
        reports.push(JSON.parse(l.replace(/^(FLOWRAD|RADLEARN)_BENCH /, "")));
      } catch {
        /* partial */
      }
    } else if (l.startsWith("FLOWRAD_DIAG") || l.startsWith("FLOWRAD_BENCH_CLOSE")) console.log(`[${label}] ${l.slice(0, 1500)}`);
  }
});
child.stderr.on("data", () => undefined);
const until = async (ok, ms, what) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end || child.exitCode != null) throw new Error(`${label}: no ${what}`);
    await sleep(100);
  }
};
const show = (tag, s) => {
  console.log(`[${label}] ${tag}: ${s.total} MB (Δ ${s.total - base.total}) (${line(s)})`);
  for (const k of ["app", "renderer", "gpu"]) if (s.cats[k]) console.log(`[${label}]   ${k} vs baseline: ${delta(base.cats[k] ?? {}, s.cats[k])}`);
};
for (const round of [1, 2]) {
  await until(() => reports.some((r) => !r.closed && r.openClose?.round === round), 180_000, `open report ${round}`);
  const t0 = Date.now();
  await sleep(Math.max(0, hold * 1000 - 3000));
  show(`round ${round} open`, sample(child.pid));
  await until(() => reports.some((r) => r.closed && r.openClose?.round === round), hold * 1000 + 30_000, `close report ${round}`);
  const tc = Date.now();
  const marks = round === 1 ? [3, 15, 30] : [3, 15, 30, 45, 60];
  for (const s of marks) {
    await sleep(Math.max(0, tc + s * 1000 - Date.now()));
    show(`round ${round} closed +${s}s`, sample(child.pid));
  }
  void t0;
}
child.kill("SIGKILL");
