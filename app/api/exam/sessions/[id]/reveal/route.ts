import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth';
import { revealExam } from '@/lib/exam/service';
import { examJson, examHttpError } from '@/lib/exam/http';
export const runtime = 'nodejs';
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { const u = await requireSession(); return examJson(await revealExam(u.activeOrgId, u.id, params.id)); } catch (e) { return examHttpError(e); }
}
