import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth';
import { getExam, examAction, parseExamOperation } from '@/lib/exam/service';
import { ExamError } from '@/lib/exam/types';
import { examJson, examHttpError } from '@/lib/exam/http';
export const runtime = 'nodejs';
type Context = { params: { id: string } };
export async function GET(_req: NextRequest, { params }: Context) { try { const u = await requireSession(); return examJson(await getExam(u.activeOrgId, u.id, params.id)); } catch (e) { return examHttpError(e); } }
export async function POST(req: NextRequest, { params }: Context) {
  try { const u = await requireSession(), body = await req.json();
    if (!body || Object.keys(body).some(k => !['action', 'revision', 'requestId'].includes(k)) || !['hint', 'retry', 'close'].includes(body.action)) throw new ExamError('Invalid examination action', 400);
    return examJson(await examAction(u.activeOrgId, u.id, params.id, body.action, parseExamOperation(body)));
  } catch (e) { return examHttpError(e); }
}
