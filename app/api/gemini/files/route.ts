// POST /api/gemini/files
// Viewport recording → Gemini Files API. The browser never sees the API key.
// Used when a teacher take is long enough for agentic video understanding.

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import { uploadGeminiFile } from "@/lib/geminiFiles";

export const runtime = "nodejs";

const MAX_BYTES = 96 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    await requireAuthorOrg();
    const form = await req.formData();
    const file = form.get("video");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "video file is required" }, { status: 400 });
    }
    if (file.size <= 0 || file.size > MAX_BYTES) {
      return NextResponse.json({ error: "Viewport recording is empty or too large" }, { status: 413 });
    }
    const mimeType = file.type || "video/webm";
    if (!mimeType.startsWith("video/")) {
      return NextResponse.json({ error: "Expected a video file" }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const uploaded = await uploadGeminiFile({
      bytes,
      mimeType,
      displayName: "viewport-recording",
    });
    return NextResponse.json({ fileUri: uploaded.uri, mimeType: uploaded.mimeType });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = /GEMINI_API_KEY/i.test(message) ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
