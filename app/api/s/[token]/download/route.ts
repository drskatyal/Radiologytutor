// Shared download: allowed only when the link's owner switched downloads on,
// and only for a study the link grants. ?study=<id> picks one study of a
// shared collection.

import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/cloud/auth";
import { resolveShare } from "@/lib/cloud/access";
import { studyZipResponse } from "@/lib/cloud/studyDownload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  try {
    const resolved = await resolveShare(params.token);
    if (!resolved) return NextResponse.json({ error: "This link has expired or was revoked." }, { status: 404 });
    if (!resolved.share.allowDownload) {
      return NextResponse.json({ error: "The owner has not allowed downloads on this link." }, { status: 403 });
    }
    const want = req.nextUrl.searchParams.get("study");
    const study = want ? resolved.studies.find((s) => s.id === want) : resolved.studies[0];
    if (!study) return NextResponse.json({ error: "Study not found." }, { status: 404 });
    return studyZipResponse(study);
  } catch (err) {
    return jsonError(err);
  }
}
