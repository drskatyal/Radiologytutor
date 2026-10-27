// Blank blocking identity tags on an Explicit VR Little Endian Part-10 file and
// write a teaching fixture the Studio upload gate will store.
//
// Not used by /api/upload. Residual PatientName / PatientID / PatientBirthDate
// on a real study still fail lib/deid.ts.
//
//   npx tsx scripts/anonymize-teaching-dicom.ts
//   npx tsx scripts/anonymize-teaching-dicom.ts public/dicom/emri_small.dcm public/dicom/teach_anon_mr.dcm

import { readFileSync, writeFileSync } from "node:fs";
import { blankBlockingIdentityTags } from "../lib/anonymizeTeachingDicom.ts";
import { evaluateDeid, inspectDicomBytes } from "../lib/deid.ts";

const input = process.argv[2] ?? "public/dicom/emri_small.dcm";
const output = process.argv[3] ?? "public/dicom/teach_anon_mr.dcm";

const src = new Uint8Array(readFileSync(input));
const { bytes, removed } = blankBlockingIdentityTags(src);
const report = inspectDicomBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const verdict = evaluateDeid(report);
if (!verdict.pass) {
  console.error("blanked file still fails the de-id gate", verdict.blocking);
  process.exit(1);
}
writeFileSync(output, bytes);
console.log(
  `wrote ${output} (${bytes.length} bytes); removed ${removed.join(", ") || "(no residual identity values)"}`
);
