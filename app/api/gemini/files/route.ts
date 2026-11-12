// POST /api/gemini/files
// Viewport recording → Gemini Files API. The browser never sees the API key.
// Used when a teacher take is long enough for agentic video understanding.

import { NextRequest, NextResponse } from "next/server";
import { requireAuthorOrg } from "@/lib/auth";
import { captureMedia, retainGeminiVideo } from "@/lib/journal/storage";
import { captureHttpError } from "@/lib/journal/http";
import { uploadGeminiFile } from "@/lib/geminiFiles";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const orgId = await requireAuthorOrg();
    const { caseId, sessionId } = await req.json();
    const media = await captureMedia(orgId, caseId, sessionId, "video", true);
    const bytes = new Uint8Array(media.bytes);
    const mimeType = media.mimeType;
    const uploaded = await uploadGeminiFile({
      bytes,
      mimeType,
      displayName: "viewport-recording",
    });
    await retainGeminiVideo(orgId, caseId, sessionId, { uri: uploaded.uri, mimeType: uploaded.mimeType });
    return NextResponse.json({ fileUri: uploaded.uri, mimeType: uploaded.mimeType });
  } catch (err) {
    if (err instanceof Error && /GEMINI_API_KEY/i.test(err.message)) return NextResponse.json({ error: "Gemini is unavailable; live contract not verified" }, { status: 503 });
    return captureHttpError(err);
  }
}
