import { NextRequest, NextResponse } from 'next/server';
import { requireRole, jsonAuthError } from '@/lib/auth';
import { approvedReplay, recordReplay } from '@/lib/replay/server';
import { ReplayError } from '@/lib/replay/types';
import { FindingConflict } from '@/lib/findingContent';
import { PhiError } from '@/lib/phiGuard';
export const runtime = 'nodejs';
type Context = { params: { caseId: string; findingId: string } };
function failure(error: unknown) {
  return jsonAuthError(error) ?? NextResponse.json({ error: error instanceof ReplayError || error instanceof FindingConflict || error instanceof PhiError ? error.message : 'Replay evidence is unavailable. Reload and retry.' }, { status: Number((error as { status?: number }).status) || (error instanceof ReplayError ? 422 : 500) });
}
export async function GET(_req: NextRequest, { params }: Context) {
  try { const user = await requireRole('author'); return NextResponse.json(await approvedReplay(user.activeOrgId, params.caseId, params.findingId), { headers: { 'Cache-Control': 'private, no-store' } }); } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest, { params }: Context) {
  try { const user = await requireRole('author'); return NextResponse.json(await recordReplay(user.activeOrgId, params.caseId, params.findingId, user.id, await req.json()), { headers: { 'Cache-Control': 'private, no-store' } }); } catch (error) { return failure(error); }
}
