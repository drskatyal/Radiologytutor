#!/usr/bin/env npx tsx
/**
 * Attach the LIDC demo teaching guide to case-lidc-nodule-search.
 *
 *   npm run seed:lidc-teach
 *
 * If the case is already in the store (for example after import:cases), each
 * finding without a teacher track gets a fresh guide built from its current
 * slice, window, marker, and prose. Findings with a RecordedTrack keep that
 * track. Either way, catalog reportGold and reportMustMention are copied onto
 * a finding that has neither. If the case is missing, this writes the catalog
 * case scaled to the public 65-slice stack so Teach can play the script before
 * a human records.
 */

import { DEFAULT_ORG_ID, getCaseForOrg, saveCase, updateFindingScoped } from "../lib/cases";
import {
  LIDC_CASE_ID,
  buildLidcSeedCase,
  findingHasTeacherTrack,
  lidcReseedPatch,
} from "../lib/demoTeachingGuide";

async function main() {
  const existing = await getCaseForOrg(DEFAULT_ORG_ID, LIDC_CASE_ID);
  if (!existing) {
    const seeded = buildLidcSeedCase();
    await saveCase(seeded);
    const slices = seeded.findings.map((finding) => finding.sliceIndex).join(", ");
    console.log(
      `Created ${LIDC_CASE_ID} with demo teaching guides on slices ${slices}.`
    );
    return;
  }

  let guides = 0;
  let kept = 0;
  let rubrics = 0;
  for (const finding of existing.findings) {
    if (findingHasTeacherTrack(finding)) {
      kept += 1;
    } else if (finding.sliceIndex == null || !finding.marker) {
      console.warn(
        `Skipped demo guide for ${finding.id}: needs a slice and a marker before a demo guide can land.`
      );
    }
    const patch = lidcReseedPatch(finding);
    if (!patch) continue;
    await updateFindingScoped(DEFAULT_ORG_ID, LIDC_CASE_ID, finding.id, patch);
    if (patch.teachingGuide) guides += 1;
    if (patch.reportGold != null || patch.reportMustMention != null) rubrics += 1;
  }
  console.log(
    `Updated ${LIDC_CASE_ID}: ${guides} demo guide(s), ${kept} teacher track(s) left in place, ${rubrics} report rubric(s) filled.`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
