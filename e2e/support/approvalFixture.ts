// Local synthetic test setup only. Never imported by application routes.
import { readFile } from "node:fs/promises";
import { mutateCase } from "../../lib/cases";
async function main() {
  const [orgId, caseId] = process.argv.slice(2);
  if (!orgId || !caseId || !process.env.DATA_DIR?.includes(".radlearn-tmp")) throw new Error("Local fixture directory required");
  const fixture = JSON.parse(await readFile("fixtures/synthetic/case.json", "utf8"));
  await mutateCase(orgId, caseId, data => ({ ...data, status: "published", studyRefs: fixture.studyRefs }));
}
void main().catch(() => { process.exitCode = 1; });
