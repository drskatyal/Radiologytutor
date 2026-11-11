import { hasActiveExam } from "@/lib/exam/access";
import { activeOrgId, getSession } from "@/lib/auth";
import { getCaseForOrg, approvedCurrent, groundedCase } from "@/lib/cases";
import { canAccessOrgResource } from "@/lib/authRoles";
// POST /api/cases/[caseId]/findings -> append a finding
// Body: a full Finding (id optional — generated if missing)

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import { createFinding } from "@/lib/cases";
import type { Finding } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { caseId: string } }) {
  try {
    const orgId = await requireAuthorOrg();
    const body = (await req.json()) as Partial<Finding>;
    if (!body.state || !body.marker) {
      return NextResponse.json(
        { error: "state and marker are required" },
        { status: 400 }
      );
    }
    const finding: Finding = {
      id: body.id || `f${Date.now().toString(36)}`,
      label: body.label || "Untitled finding",
      description: body.description || "",
      teachingPoints: body.teachingPoints || [],
      state: body.state,
      marker: body.marker,
      keyframes: body.keyframes,
      // Self-hosted record/replay: ordered event log + narration audio.
      track: body.track,
      durationMs: body.durationMs,
      // Teach script from a recorded take or a no-mic click-annotate save.
      teachingGuide: body.teachingGuide,
      order: body.order ?? 0,
      // Series/study anchors — drive student series switch + prefetch.
      studyInstanceUID: body.studyInstanceUID,
      seriesInstanceUID: body.seriesInstanceUID,
      sopInstanceUIDs: body.sopInstanceUIDs,
      sopInstanceUID: body.sopInstanceUID,
      sliceIndex: body.sliceIndex,
      frameNumber: body.frameNumber,
      imagePoint: body.imagePoint,
      anchor: body.anchor,
      phiReview: body.phiReview,
      landmark: body.landmark?.trim() || undefined,
      windowWidth: body.windowWidth,
      windowCenter: body.windowCenter,
      measurements: body.measurements,
      anchors: body.anchors,
      captureSessionId: body.captureSessionId,
      tStartMs: body.tStartMs,
      tEndMs: body.tEndMs,
    };
    const updated = await createFinding(orgId, params.caseId, finding);
    return NextResponse.json(updated);
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(_req: NextRequest, { params }: { params: { caseId: string } }) {
  if (await hasActiveExam(params.caseId)) return NextResponse.json({ error: "Unavailable during examination" }, { status: 403 });
  const orgId = await activeOrgId();
  const data = await getCaseForOrg(orgId, params.caseId);
  const session = await getSession();
  if (!data || (data.status !== "published" && !canAccessOrgResource({ membershipRole: session?.user.membershipRole, platformRole: session?.user.platformRole, need: "author" }))) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  return NextResponse.json(await approvedCurrent(orgId, params.caseId));
}
