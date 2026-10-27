// POST /api/cases/[caseId]/live-teaching-pack
// Commit a compiled take. Prose and clinical importance come from the body.
// Viewer anchors are rebuilt from the capture session already stored on the case.

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import { commitLiveTeachingPack } from "@/lib/cases";
import type { CompiledTakeDraft } from "@/lib/liveTeachingPack";

export const runtime = "nodejs";

function drafts(raw: unknown): CompiledTakeDraft[] {
  if (!Array.isArray(raw)) return [];
  const out: CompiledTakeDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (!label) continue;
    const tStartMs = Number(row.tStartMs);
    const tEndMs = Number(row.tEndMs);
    const importance = Number(row.clinicalImportance);
    const mimics = Array.isArray(row.mimics)
      ? row.mimics.filter((item): item is string => typeof item === "string")
      : [];
    out.push({
      label,
      description: typeof row.description === "string" ? row.description : "",
      teachingPoints: Array.isArray(row.teachingPoints)
        ? row.teachingPoints.filter((point): point is string => typeof point === "string")
        : [],
      ...(typeof row.whatToNotice === "string" ? { whatToNotice: row.whatToNotice } : {}),
      ...(typeof row.pearl === "string" ? { pearl: row.pearl } : {}),
      ...(typeof row.whyClinicallyFirst === "string" ? { whyClinicallyFirst: row.whyClinicallyFirst } : {}),
      ...(typeof row.reportLine === "string" ? { reportLine: row.reportLine } : {}),
      ...(typeof row.landmark === "string" ? { landmark: row.landmark } : {}),
      ...(mimics.length ? { mimics } : {}),
      tStartMs: Number.isFinite(tStartMs) ? tStartMs : 0,
      tEndMs: Number.isFinite(tEndMs) ? tEndMs : 0,
      ...(Number.isFinite(importance) && importance > 0
        ? { clinicalImportance: Math.round(importance) }
        : {}),
    });
  }
  return out;
}

export async function POST(req: NextRequest, { params }: { params: { caseId: string } }) {
  try {
    const orgId = await requireAuthorOrg();
    const body = (await req.json()) as Record<string, unknown>;
    const captureSessionId =
      typeof body.captureSessionId === "string" ? body.captureSessionId.trim() : "";
    if (!captureSessionId) {
      return NextResponse.json({ error: "captureSessionId is required" }, { status: 400 });
    }
    const updated = await commitLiveTeachingPack(orgId, params.caseId, {
      captureSessionId,
      transcript: typeof body.transcript === "string" ? body.transcript : undefined,
      seriesInstanceUID:
        typeof body.seriesInstanceUID === "string" ? body.seriesInstanceUID : undefined,
      studyInstanceUID:
        typeof body.studyInstanceUID === "string" ? body.studyInstanceUID : undefined,
      findings: drafts(body.findings),
    });
    return NextResponse.json(updated);
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = /not found|no findings/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
