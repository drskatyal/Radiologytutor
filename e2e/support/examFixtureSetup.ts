// Synthetic localhost fixture only. No remote data or model calls.
import { createVersion, approve, mutateCase, getCaseForOrg } from '../../lib/cases';
async function main() {
  const [orgId, caseId] = process.argv.slice(2);
  if (!orgId || !caseId?.startsWith('case-capture-') || !process.env.DATA_DIR?.endsWith('.radlearn-tmp/radlearn-data')) throw new Error('Synthetic local fixture required');
  const data = (await getCaseForOrg(orgId, caseId))!, f = data.findings.find(f => f.id === 'replay-one')!;
  const next = await createVersion(orgId, caseId, f.id, { label: 'CANARY_REFERENCE_M10', reportMustMention: ['round opacity'] }, { expectedVersion: f.currentVersion!, userId: 'synthetic-reviewer' });
  const version = next.findingVersions!.at(-1)!;
  await approve(orgId, caseId, f.id, version.version, version.contentHash, { id: 'synthetic-reviewer', membershipRole: 'author' });
  await mutateCase(orgId, caseId, c => ({ ...c, title: 'CANARY_CASE_TITLE', primaryDiagnosis: 'CANARY_CASE_DIAGNOSIS', status: 'published' }));
}
void main().catch(() => { console.error('Synthetic exam fixture failed'); process.exitCode = 1; });
