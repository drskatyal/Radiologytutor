// Build a converted bundle of the bench's synthetic series with the REAL
// packer (lib/dicomCdn/pack.ts), reading pixels back through the mock's own
// WADO-RS frames — so the `bundle` profile in run.mjs measures exactly what
// production would serve.
//
//   npx tsx scripts/bench/packBundle.ts --slices 240 --rows 512 --out scripts/bench/.build/bundle

import { rm } from "node:fs/promises";
import { buildSeriesBundle, type ArchiveReader } from "../../lib/dicomCdn/pack";
import { openBundleStore } from "../../lib/dicomCdn/store";
import { SERIES_UID, STUDY_UID, startMockDicomweb } from "./mockDicomweb.mjs";

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

async function main() {
  const slices = Number(arg("slices", "240"));
  const rows = Number(arg("rows", "512"));
  const columns = Number(arg("columns", String(rows)));
  const out = arg("out", "scripts/bench/.build/bundle");
  await rm(out, { recursive: true, force: true });

  const mock = await startMockDicomweb({ slices, rows, columns, latencyMs: 0, metadataBuildMs: 0 });
  const root = `${mock.origin}/dicomweb/studies/${STUDY_UID}/series/${SERIES_UID}`;
  const reader: ArchiveReader = {
    async seriesMetadata() {
      return (await (await fetch(`${root}/metadata`)).json()) as unknown[];
    },
    async instancePixels(_study, _series, sop) {
      const res = await fetch(`${root}/instances/${sop}/frames/1`);
      const body = new Uint8Array(await res.arrayBuffer());
      // Single-part multipart: payload sits between the first blank line and the closing boundary.
      let start = 0;
      for (let i = 0; i < body.length - 3; i++) {
        if (body[i] === 13 && body[i + 1] === 10 && body[i + 2] === 13 && body[i + 3] === 10) {
          start = i + 4;
          break;
        }
      }
      return { transferSyntaxUID: "1.2.840.10008.1.2.1", bytes: body.subarray(start, start + rows * columns * 2) };
    },
  };
  try {
    const { stats, index } = await buildSeriesBundle(openBundleStore({ kind: "local", dir: out }), STUDY_UID, SERIES_UID, {
      archive: reader,
      concurrency: 8,
    });
    console.log(
      JSON.stringify({
        frames: stats.frames,
        sourceMB: +(stats.sourceBytes / 1e6).toFixed(1),
        htj2kMB: +(stats.fullBytes / 1e6).toFixed(1),
        previewMB: +(stats.previewBytes / 1e6).toFixed(2),
        metaKB: Math.round(stats.metaBytes / 1024),
        previewChunks: index.previews.chunks.length,
        fullChunks: index.frames.chunks.length,
        packSeconds: +(stats.ms / 1000).toFixed(1),
      })
    );
  } finally {
    await mock.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
