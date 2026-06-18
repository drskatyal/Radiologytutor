// GET /api/cases/[caseId] -> single case

import { NextRequest, NextResponse } from "next/server";
import { getCase } from "@/lib/cases";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: { caseId: string } }) {
  const data = await getCase(params.caseId);
  if (!data) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  return NextResponse.json(data);
}
