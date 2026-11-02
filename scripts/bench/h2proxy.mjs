#!/usr/bin/env node
// HTTP/2 (TLS) front for a local `next start`, so a browser benchmark sees
// what production sees: one multiplexed connection instead of HTTP/1.1's six
// sockets per host, which on its own caps a 620 ms-per-frame archive at
// ~10 frames/s and hides every concurrency change.
//
//   node scripts/bench/h2proxy.mjs --port 8443 --target http://127.0.0.1:3123
//   (self-signed cert generated into the OS temp dir; launch Chrome with
//    ignoreHTTPSErrors)

import http2 from "node:http2";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const PORT = Number(args.get("port") ?? 8443);
const TARGET = (args.get("target") ?? "http://127.0.0.1:3123").replace(/\/$/, "");

const key = join(tmpdir(), "radlearn-h2-key.pem");
const cert = join(tmpdir(), "radlearn-h2-cert.pem");
if (!existsSync(key) || !existsSync(cert)) {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-subj", "/CN=127.0.0.1", "-keyout", key, "-out", cert,
  ], { stdio: "ignore" });
}

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "host"]);

const server = http2.createSecureServer(
  { key: readFileSync(key), cert: readFileSync(cert), allowHTTP1: true },
  async (req, res) => {
    try {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.startsWith(":") || HOP.has(k)) continue;
        headers[k] = Array.isArray(v) ? v.join(", ") : v;
      }
      headers["x-forwarded-proto"] = "https";
      const chunks = [];
      if (req.method !== "GET" && req.method !== "HEAD") for await (const c of req) chunks.push(c);
      const upstream = await fetch(TARGET + req.url, {
        method: req.method,
        headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
        redirect: "manual",
      });
      const out = {};
      upstream.headers.forEach((v, k) => {
        if (!HOP.has(k) && k !== "content-length" && k !== "content-encoding") out[k] = v;
      });
      const setCookie = upstream.headers.getSetCookie?.();
      if (setCookie?.length) out["set-cookie"] = setCookie;
      // fetch() already decoded any Content-Encoding; re-send identity bytes
      // and report what the origin used so the bench can still see it.
      const enc = upstream.headers.get("content-encoding");
      if (enc) out["x-origin-content-encoding"] = enc;
      res.writeHead(upstream.status, out);
      if (upstream.body) for await (const c of upstream.body) res.write(c);
      res.end();
    } catch (err) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(String(err));
    }
  }
);
server.listen(PORT, "127.0.0.1", () => console.log(`h2 proxy https://127.0.0.1:${PORT} → ${TARGET}`));
