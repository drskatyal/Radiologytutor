#!/usr/bin/env npx tsx
/**
 * Import real teaching cases from the public catalog (TCIA DICOM + metadata).
 *
 *   ORTHANC_URL=http://127.0.0.1:8042 npx tsx scripts/import-public-cases.ts
 *   ORTHANC_URL=... npx tsx scripts/import-public-cases.ts case-lidc-nodule-search
 */

import { importAllPublicCases, importPublicCase } from "../lib/dicomImport/importPublicCase";
import { listPublicCaseTemplates } from "../lib/publicCases/catalog";

async function main() {
  const target = process.argv[2];
  if (target === "--list") {
    for (const t of listPublicCaseTemplates()) {
      console.log(`${t.caseId}\t${t.title}\t${t.source.kind}`);
    }
    return;
  }

  if (target) {
    const result = await importPublicCase(target, { publish: true });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { ok, failed } = await importAllPublicCases({ publish: true });
  console.log(`Imported ${ok.length} case(s):`);
  for (const r of ok) {
    console.log(
      `  ✓ ${r.caseId} — ${r.instanceCount} instances (${r.ingestedInstances} newly ingested)`
    );
  }
  if (failed.length) {
    console.error(`Failed ${failed.length}:`);
    for (const f of failed) console.error(`  ✗ ${f.caseId}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
