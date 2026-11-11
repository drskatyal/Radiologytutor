import "server-only";
import { getSession } from "../auth";
import { findActiveExam } from "../cases";
export async function hasActiveExam(caseId?: string): Promise<boolean> {
  const session = await getSession();
  return !!session && !!(await findActiveExam(session.user.activeOrgId, session.user.id, caseId));
}
