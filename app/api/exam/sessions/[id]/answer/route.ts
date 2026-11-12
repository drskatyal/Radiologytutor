import { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { examJson, examHttpError } from "@/lib/exam/http";
import { parseExamAnswer, submitExamAnswer, parseExamOperation } from "@/lib/exam/service";
import { ExamError } from "@/lib/exam/types";
export const runtime = "nodejs";
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession();
    const body = await req.json();
    if (!body || Object.keys(body).some(k => !["answer", "close", "revision", "requestId", "assisted"].includes(k)) || (body.close !== undefined && typeof body.close !== "boolean")) throw new ExamError("Invalid answer request", 400);
    return examJson(await submitExamAnswer(user.activeOrgId, user.id, params.id, parseExamAnswer(body.answer), body.close === true, parseExamOperation(body)));
  } catch (error) {
    return examHttpError(error);
  }
}
