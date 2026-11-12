import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth';
import { ownedExam } from '@/lib/exam/service';
import { geminiConfigured, transcribeAudio } from '@/lib/gemini';
import { tutorAudio, tutorText } from '@/lib/tutor/input';
import { ExamError } from '@/lib/exam/types';
import { examJson, examHttpError } from '@/lib/exam/http';
export const runtime = 'nodejs';
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try { const u = await requireSession(); await ownedExam(u.activeOrgId, u.id, params.id, true);
    const body = await req.json();
    if (!body || Object.keys(body).some(k => k !== 'audio')) throw new ExamError('Only learner audio is accepted.', 400);
    let audio: ReturnType<typeof tutorAudio>;
    try { audio = tutorAudio(body.audio); }
    catch { throw new ExamError('A supported recording and confirmation of no patient identifiers are required.', 422); }
    if (!geminiConfigured()) throw new ExamError('Voice transcription is unavailable. Type your observations instead.', 503);
    const transcript = tutorText(await transcribeAudio(audio.base64, audio.mime));
    await ownedExam(u.activeOrgId, u.id, params.id, true);
    return examJson({ transcript, reviewRequired: true });
  } catch (e) { return examHttpError(e); }
}
