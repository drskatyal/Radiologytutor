// POST /api/audio — store a narration clip captured during record → replay.
//
// Body:  { base64: string, mimeType?: string }
// Reply: { id, url, mimeType, bytes }     (200)
//        { error: string }                 (4xx/5xx)
//
// The clip is persisted via the storage seam (lib/audioStore) — R2 when
// configured, DATA_DIR otherwise. The returned same-origin `url`
// (/api/audio/<id>) is what we save on the finding's track.

import { NextRequest, NextResponse } from "next/server";
import { putAudio } from "@/lib/audioStore";

export const runtime = "nodejs";

// Recordings can be a few MB of base64 — lift the default body cap.
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { base64, mimeType } = await req.json();
    if (typeof base64 !== "string" || !base64) {
      return NextResponse.json({ error: "base64 is required" }, { status: 400 });
    }
    const stored = await putAudio(base64, typeof mimeType === "string" ? mimeType : "audio/webm");
    return NextResponse.json(stored);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
