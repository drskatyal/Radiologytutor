// ============================================================================
// scripts/dicom-cdn-backfill.ts
//
// Convert studies that were uploaded before converted delivery existed:
// lossless HTJ2K frames + 8-bit JPEG previews + gzip metadata, per series,
// into the private bundle bucket (lib/dicomCdn/pack.ts — the same code the
// app runs after an upload). Idempotent: a series whose current bundle is the
// same schema is skipped unless --force.
//
//   npm run dicom-cdn:backfill -- --all                 every case, every org
//   npm run dicom-cdn:backfill -- --case case-lidc-nodule-search
//   npm run dicom-cdn:backfill -- --study 1.2.3 [--series 1.2.3.4]
//   options: --force  --dry-run  --concurrency 6  --parallel-series 2
//
// Env: the archive (DICOMWEB_BACKEND=healthcare + HEALTHCARE_* , or
// ORTHANC_URL) and the store (DICOM_CDN_BUCKET, or DICOM_CDN_LOCAL_DIR).
// --all / --case read cases through lib/cases.ts, so set MONGODB_URI for
// production (JSON DATA_DIR otherwise). From a laptop against GCP:
//   GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token)
// lets both the Healthcare API and the bucket accept the calls; on Cloud Run
// (a job using the app image) the runtime service account is used instead.
//
// De-identification: unchanged. This reads what is already in the archive —
// which only ever received bytes that passed lib/deid.ts — and writes derived
// pixels to a private bucket. Nothing is made public.
// ============================================================================

import { getCase, listCaseImagingRefsAllOrgs } from "../lib/cases";
import { dicomCdnConfig } from "../lib/dicomCdn/config";
import { BUNDLE_SCHEMA, isDicomUid } from "../lib/dicomCdn/format";
import { NotConvertibleError, buildSeriesBundle, readSeriesIndex } from "../lib/dicomCdn/pack";
import { openBundleStore } from "../lib/dicomCdn/store";
import { dicomWebRoot } from "../lib/imagingBackend";
import { imagingAuthHeader, orthancConfigured } from "../lib/orthanc";

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) out.push(process.argv[i + 1]);
  });
  return out;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const num = (name: string, fallback: number) => {
  const v = Number(args(name)[0]);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
};

interface Target {
  study: string;
  series: string;
  label: string;
}

async function seriesOfStudy(study: string): Promise<string[]> {
  const res = await fetch(`${dicomWebRoot()}/studies/${encodeURIComponent(study)}/series?includefield=0020000E`, {
    headers: { Authorization: await imagingAuthHeader(), Accept: "application/dicom+json" },
  });
  if (!res.ok) throw new Error(`QIDO series for ${study} -> ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, { Value?: unknown[] }>>;
  return rows
    .map((r) => r["0020000E"]?.Value?.[0])
    .filter((v): v is string => typeof v === "string" && isDicomUid(v));
}

async function collectTargets(): Promise<Target[]> {
  const refs: Array<{ label: string; study: string; series: string[] }> = [];
  if (flag("all")) {
    for (const r of await listCaseImagingRefsAllOrgs()) {
      refs.push({ label: `${r.orgId}/${r.caseId}`, study: r.studyInstanceUID, series: r.seriesInstanceUIDs });
    }
  }
  for (const caseId of args("case")) {
    const c = await getCase(caseId);
    if (!c) throw new Error(`No case ${caseId}`);
    const byStudy = new Map<string, Set<string>>();
    for (const ref of c.studyRefs ?? []) {
      const set = byStudy.get(ref.studyInstanceUID) ?? new Set<string>();
      for (const s of ref.seriesInstanceUIDs ?? []) set.add(s);
      byStudy.set(ref.studyInstanceUID, set);
    }
    for (const f of c.findings ?? []) {
      const study = f.studyInstanceUID ?? c.studyRefs?.[0]?.studyInstanceUID;
      if (!study) continue;
      const set = byStudy.get(study) ?? new Set<string>();
      if (f.seriesInstanceUID) set.add(f.seriesInstanceUID);
      byStudy.set(study, set);
    }
    for (const [study, series] of byStudy) refs.push({ label: caseId, study, series: [...series] });
  }
  const studies = args("study");
  const explicitSeries = args("series");
  for (const study of studies) {
    refs.push({ label: "cli", study, series: studies.length === 1 ? explicitSeries : [] });
  }

  const seen = new Set<string>();
  const out: Target[] = [];
  for (const ref of refs) {
    if (!isDicomUid(ref.study)) {
      console.warn(`skip ${ref.label}: not a StudyInstanceUID (${ref.study})`);
      continue;
    }
    // A reference with no series converts every series of the study.
    const series = ref.series.length > 0 ? ref.series : await seriesOfStudy(ref.study);
    for (const s of series) {
      const key = `${ref.study}|${s}`;
      if (seen.has(key) || !isDicomUid(s)) continue;
      seen.add(key);
      out.push({ study: ref.study, series: s, label: ref.label });
    }
  }
  return out;
}

const mb = (n: number) => (n / 1e6).toFixed(1);

async function main(): Promise<void> {
  const config = dicomCdnConfig();
  if (!config) {
    console.error("Set DICOM_CDN_BUCKET (or DICOM_CDN_LOCAL_DIR) to say where converted series go.");
    process.exit(2);
  }
  if (!orthancConfigured()) {
    console.error("No imaging archive configured (DICOMWEB_BACKEND=healthcare + HEALTHCARE_*, or ORTHANC_URL).");
    process.exit(2);
  }
  if (!flag("all") && args("case").length === 0 && args("study").length === 0) {
    console.error("Nothing to do. Pass --all, --case <caseId> or --study <uid> [--series <uid>].");
    process.exit(2);
  }
  const store = openBundleStore(config.store);
  const targets = await collectTargets();
  const force = flag("force");
  const dryRun = flag("dry-run");
  const concurrency = num("concurrency", 6);
  const parallel = num("parallel-series", 2);
  console.log(
    `${targets.length} series → ${config.store.kind === "gcs" ? `gs://${config.store.bucket}` : config.store.dir}` +
      `${dryRun ? " (dry run)" : ""}${force ? " (force)" : ""}`
  );

  const totals = { converted: 0, skipped: 0, failed: 0, frames: 0, source: 0, full: 0, preview: 0 };
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const t = targets[next++];
      const name = `${t.label} ${t.series}`;
      try {
        const current = (await readSeriesIndex(store, t.study, t.series)) as { schema?: number } | null;
        if (current?.schema === BUNDLE_SCHEMA && !force) {
          totals.skipped += 1;
          console.log(`= ${name} (already converted)`);
          continue;
        }
        if (dryRun) {
          console.log(`~ ${name} (would convert)`);
          continue;
        }
        const { stats, index } = await buildSeriesBundle(store, t.study, t.series, { concurrency });
        totals.converted += 1;
        totals.frames += stats.frames;
        totals.source += stats.sourceBytes;
        totals.full += stats.fullBytes;
        totals.preview += stats.previewBytes;
        console.log(
          `✓ ${name}: ${stats.frames} frames, source ${mb(stats.sourceBytes)} MB → HTJ2K ${mb(stats.fullBytes)} MB` +
            ` + previews ${mb(stats.previewBytes)} MB, ${index.frames.chunks.length + index.previews.chunks.length} chunks,` +
            ` ${(stats.ms / 1000).toFixed(1)} s` +
            (index.fallbackFrames ? `, ${index.fallbackFrames} fallback frames` : "")
        );
      } catch (e) {
        if (e instanceof NotConvertibleError) {
          totals.skipped += 1;
          console.log(`- ${name}: stays on DICOMweb (${e.message})`);
        } else {
          totals.failed += 1;
          console.error(`✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, Math.max(1, targets.length)) }, worker));

  console.log(
    `\nconverted ${totals.converted}, skipped ${totals.skipped}, failed ${totals.failed}; ` +
      `${totals.frames} frames, source ${mb(totals.source)} MB → HTJ2K ${mb(totals.full)} MB + previews ${mb(totals.preview)} MB` +
      (totals.source > 0 ? ` (${((totals.full / totals.source) * 100).toFixed(0)}% of source)` : "")
  );
  if (totals.failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
