import { NextRequest, NextResponse } from "next/server";
import { requireAuthorOrg } from "@/lib/auth";
import { captureMedia } from "@/lib/journal/storage";
import { captureHttpError } from "@/lib/journal/http";
import { CaptureError } from "@/lib/journal/manifest";
export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: { caseId: string; sessionId: string } }) {
  try {
    const orgId = await requireAuthorOrg(), stream = req.nextUrl.searchParams.get("stream");
    if (stream !== "audio" && stream !== "video") throw new CaptureError("Choose audio or video");
    // Author review is allowed before the PHI checkbox; model use is gated separately.
    const media = await captureMedia(orgId, params.caseId, params.sessionId, stream);
    return new NextResponse(new Uint8Array(media.bytes), { headers: { "Content-Type": media.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return captureHttpError(error); }
}
