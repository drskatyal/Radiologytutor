/**
 * Record → guide → play.
 *
 *   npm run eval:record-guide
 *
 * Loads the checked-in LIDC finding-1 take (WAV + timed transcript), runs the
 * same alignment as POST /api/transcribe-narration, saves the finding, and
 * plays the cleaned guide. Exit 0 only when the demo script is superseded,
 * the search act scroll-walks, and spoken_beat + drive-first (look_with_drive)
 * pass. No microphone and no Gemini key.
 */

import {
  formatRecordedTourReport,
  recordedTourContractHeld,
  runRecordedTour,
} from "../lib/recordedTour";

async function main(): Promise<void> {
  const report = await runRecordedTour();
  console.log(formatRecordedTourReport(report));
  if (!recordedTourContractHeld(report)) {
    const failed = report.driver.beats[0]?.checks.filter((check) => !check.pass) ?? [];
    if (failed.length) {
      console.error("");
      console.error(failed.map((check) => `${check.id}: ${check.detail}`).join("\n"));
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
