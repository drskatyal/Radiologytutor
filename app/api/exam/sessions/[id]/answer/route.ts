import { NextRequest, NextResponse } from "next/server";
import { requireSession, jsonAuthError } from "@/lib/auth";
import { parseExamAnswer, submitExamAnswer } from "@/lib/exam/service";
import { ExamError } from "@/lib/exam/types";
export const runtime = "nodejs";
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession();
    const body = await req.json();
    return NextResponse.json(await submitExamAnswer(user.activeOrgId, user.id, params.id, parseExamAnswer(body.answer), body.close === true));
  } catch (error) {
    return jsonAuthError(error) ?? NextResponse.json({ error: error instanceof ExamError ? error.message : "Cannot save answer" }, { status: error instanceof ExamError ? error.status : 400 });
  }
}
