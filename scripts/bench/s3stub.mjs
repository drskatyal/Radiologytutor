#!/usr/bin/env node
// Minimal path-style S3 stub (PUT/GET/HEAD object) for exercising the R2/GCS
// frame cache locally. Ignores auth. In memory. Not for anything else.
//
//   node scripts/bench/s3stub.mjs --port 9000
//   R2_ENDPOINT=http://127.0.0.1:9000 R2_BUCKET=frames R2_ACCESS_KEY_ID=x R2_SECRET_ACCESS_KEY=x
import { createServer } from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 9000);
const store = new Map();
let gets = 0, hits = 0, puts = 0;
createServer(async (req, res) => {
  const key = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (key === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ objects: store.size, gets, hits, puts }));
  }
  if (req.method === "PUT") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    store.set(key, { body: Buffer.concat(chunks), type: req.headers["content-type"] || "application/octet-stream" });
    puts += 1;
    res.writeHead(200, { etag: '"stub"' });
    return res.end();
  }
  if (req.method === "GET" || req.method === "HEAD") {
    gets += 1;
    const hit = store.get(key);
    if (!hit) {
      res.writeHead(404, { "content-type": "application/xml" });
      return res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
    }
    hits += 1;
    res.writeHead(200, { "content-type": hit.type, "content-length": hit.body.length, etag: '"stub"' });
    return res.end(req.method === "HEAD" ? undefined : hit.body);
  }
  res.writeHead(405).end();
}).listen(port, "127.0.0.1", () => console.log(`s3 stub on :${port}`));
