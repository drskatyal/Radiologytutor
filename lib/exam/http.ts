import { NextResponse } from 'next/server';
import { jsonAuthError } from '../auth';
import { ExamError } from './types';
import { PhiError } from '../phiGuard';
export const examJson = (body: unknown) => NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
export function examHttpError(error: unknown) {
  return jsonAuthError(error) ?? NextResponse.json({ error: error instanceof ExamError || error instanceof PhiError ? error.message : 'Examination request failed. Try again.' }, { status: error instanceof ExamError || error instanceof PhiError ? error.status : 503, headers: { 'Cache-Control': 'private, no-store' } });
}
