import { NextRequest, NextResponse } from "next/server";
import { requireSession, jsonAuthError } from "@/lib/auth";
import { startExam } from "@/lib/exam/service";
import { ExamError } from "@/lib/exam/types";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json();
    if (typeof body.caseId !== "string") return NextResponse.json({ error: "caseId required" }, { status: 400 });
    return NextResponse.json(await startExam(user.activeOrgId, user.id, body.caseId));
  } catch (error) {
    return jsonAuthError(error) ?? NextResponse.json({ error: error instanceof ExamError ? error.message : "Cannot start examination" }, { status: error instanceof ExamError ? error.status : 400 });
  }
}
