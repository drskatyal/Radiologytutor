import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { ownedExam } from '@/lib/exam/service';
import { examinerUtterance } from '@/lib/exam/voice';
import { geminiConfigured, synthesizeSpeech } from '@/lib/gemini';
import { ExamError } from '@/lib/exam/types';
import { examHttpError } from '@/lib/exam/http';
export const runtime = 'nodejs';
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try { const u = await requireSession(), attempt = await ownedExam(u.activeOrgId, u.id, params.id, true), body = await req.json();
    if (!body || Object.keys(body).some(k => k !== 'kind')) throw new ExamError('Only a neutral examiner prompt may be spoken.', 400);
    const text = examinerUtterance(body.kind, attempt.events?.filter(e => e.kind === 'hint').length ?? 0);
    if (!geminiConfigured()) throw new ExamError('Examiner audio is unavailable. Read the prompt on screen.', 503);
    const audio = await synthesizeSpeech(text, { persona: 'examiner' });
    await ownedExam(u.activeOrgId, u.id, params.id, true);
    return new NextResponse(audio.audio as unknown as BodyInit, { headers: { 'Content-Type': audio.mimeType, 'Cache-Control': 'private, no-store' } });
  } catch (e) { return examHttpError(e); }
}
