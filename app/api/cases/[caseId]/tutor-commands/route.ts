import { NextRequest, NextResponse } from 'next/server';
import { requireSession, activeOrgId, jsonAuthError } from '@/lib/auth';
import { hasActiveExam } from '@/lib/exam/access';
import { loadTutorCommand } from '@/lib/tutor/server';
import { TutorCommandError } from '@/lib/tutor/commands';
export const runtime = 'nodejs';
export async function POST(req: NextRequest, { params }: { params: { caseId: string } }) {
  try {
    await requireSession();
    if (await hasActiveExam()) return NextResponse.json({ error: 'Teaching commands are unavailable during examination.' }, { status: 403 });
    const body = await req.json();
    if (!body || Object.keys(body).some(k => !['command', 'currentFindingId', 'currentView'].includes(k))) throw new TutorCommandError('Invalid command request.');
    return NextResponse.json(await loadTutorCommand(await activeOrgId(), params.caseId, body.command, body.currentFindingId, body.currentView), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) { return jsonAuthError(err) ?? NextResponse.json({ error: err instanceof TutorCommandError ? err.message : 'Approved tutor commands are unavailable.' }, { status: err instanceof TutorCommandError ? 422 : 503 }); }
}
