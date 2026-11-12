// Local synthetic M9 fixture only. No cloud, provider or credential access.
import { mutateCase } from '../../lib/cases';
async function main() {
  const [orgId, caseId] = process.argv.slice(2);
  if (!orgId || !caseId?.startsWith('case-capture-') || !process.env.DATA_DIR?.endsWith('.radlearn-tmp/radlearn-data')) throw new Error('Local synthetic fixture directory required');
  await mutateCase(orgId, caseId, data => ({ ...data, status: 'published' }));
}
void main().catch(() => { console.error('Synthetic tutor fixture failed'); process.exitCode = 1; });
