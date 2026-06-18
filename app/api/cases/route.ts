// GET  /api/cases        -> list all cases
// POST /api/cases        -> create a case { caseId, title, modality, pacsbinBaseUrl }

import { NextRequest, NextResponse } from "next/server";
import { listCases, createCase } from "@/lib/cases";
import { parseBaseUrl } from "@/lib/pacsbinUrl";

export const runtime = "nodejs";

export async function GET() {
  const cases = await listCases();
  return NextResponse.json(cases);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { caseId, title, modality, pacsbinBaseUrl } = body ?? {};
    if (!caseId || !title || !pacsbinBaseUrl) {
      return NextResponse.json(
        { error: "caseId, title and pacsbinBaseUrl are required" },
        { status: 400 }
      );
    }
    const created = await createCase(
      String(caseId),
      String(title),
      String(modality ?? "MR"),
      parseBaseUrl(String(pacsbinBaseUrl))
    );
    return NextResponse.json(created);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
