// Local synthetic ownership, without bypassing the production pixel access gate.
import { readFile } from "node:fs/promises";
import { createStudy, mutateCase } from "../../lib/cases";
async function main() {
  const [orgId, caseId] = process.argv.slice(2);
  if (!orgId || !caseId || !process.env.DATA_DIR?.includes(".radlearn-tmp")) throw new Error("Local fixture directory required");
  const fixture = JSON.parse(await readFile("fixtures/synthetic/case.json", "utf8"));
  await mutateCase(orgId, caseId, data => ({ ...data, status: "draft", studyRefs: fixture.studyRefs }));
  await createStudy(orgId, { patientId: "synthetic-patient", studyInstanceUID: fixture.studyRefs[0].studyInstanceUID, modality: "CT", description: "Synthetic capture study", seriesInstanceUIDs: fixture.studyRefs[0].seriesInstanceUIDs });
}
void main().catch(() => { process.exitCode = 1; });
