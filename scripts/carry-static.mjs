#!/usr/bin/env node
// Keep the previous deploy's /_next/static files in the new image, so a tab
// that loaded the old build can still fetch its lazy chunks after a deploy
// (otherwise: "Loading chunk N failed" the moment the old container is gone).
//
// Historical optional maintenance tool; no longer run by the Cloud Run image
// build. Remote asset retrieval needs separate explicit authorization:
//
//   node scripts/carry-static.mjs [--from https://live.example.com] [--keep-days 7]
//
// 1. Every build publishes public/_static-manifest.json: each file under
//    .next/static with the last time it was part of a live build.
// 2. The next build fetches the LIVE site's manifest and downloads each file
//    it does not have (content-hashed names never collide), skipping files
//    not live for more than --keep-days. Carried files keep their date, so
//    an old build's chunks age out instead of piling up.
// 3. Best effort: no --from, an unreachable site or a missing manifest leaves
//    the build as it is (the client still retries and reloads once).

import fs from "node:fs";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const STATIC_DIR = path.resolve(".next/static");
const MANIFEST_OUT = path.resolve("public/_static-manifest.json");
const from = (arg("--from", process.env.STATIC_CARRY_FROM || "") || "").replace(/\/$/, "");
const keepDays = Number(arg("--keep-days", process.env.STATIC_CARRY_KEEP_DAYS || 7));
const now = new Date();

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

if (!fs.existsSync(STATIC_DIR)) {
  console.error("[carry-static] .next/static not found: run after `next build`");
  process.exit(1);
}

const own = new Set(walk(STATIC_DIR));
/** path -> ISO time it was last part of a live build */
const entries = new Map([...own].map((p) => [p, now.toISOString()]));
let carried = 0;
let bytes = 0;

if (from) {
  try {
    const res = await fetch(`${from}/_static-manifest.json`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const previous = await res.json();
    const cutoff = now.getTime() - keepDays * 86_400_000;
    const wanted = (previous.files ?? []).filter(
      (f) => typeof f.path === "string" && !own.has(f.path) && Date.parse(f.lastLive) >= cutoff && !f.path.includes("..")
    );
    // A few at a time: the live site keeps serving users meanwhile.
    for (let i = 0; i < wanted.length; i += 8) {
      await Promise.all(
        wanted.slice(i, i + 8).map(async (f) => {
          try {
            const r = await fetch(`${from}/_next/static/${f.path}`, { signal: AbortSignal.timeout(30_000) });
            if (!r.ok) return;
            const body = Buffer.from(await r.arrayBuffer());
            if (typeof f.size === "number" && body.length !== f.size) return; // partial: never ship it
            const dest = path.join(STATIC_DIR, f.path);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, body);
            entries.set(f.path, f.lastLive);
            carried += 1;
            bytes += body.length;
          } catch {
            /* one file: skip it */
          }
        })
      );
    }
    console.log(
      `[carry-static] carried ${carried} of ${wanted.length} files (${(bytes / 1048576).toFixed(1)} MB) from ${from} (build ${previous.buildId ?? "?"})`
    );
  } catch (error) {
    console.warn(`[carry-static] nothing carried from ${from}: ${error.message}`);
  }
} else {
  console.log("[carry-static] no --from / STATIC_CARRY_FROM: publishing this build's manifest only");
}

let buildId = null;
try {
  buildId = fs.readFileSync(".next/BUILD_ID", "utf8").trim();
} catch {
  /* not fatal */
}
const files = [...entries].map(([p, lastLive]) => ({
  path: p,
  lastLive,
  size: fs.statSync(path.join(STATIC_DIR, p)).size,
}));
fs.mkdirSync(path.dirname(MANIFEST_OUT), { recursive: true });
fs.writeFileSync(MANIFEST_OUT, JSON.stringify({ buildId, builtAt: now.toISOString(), files }) + "\n");
console.log(`[carry-static] manifest: ${files.length} files (${own.size} from this build)`);
