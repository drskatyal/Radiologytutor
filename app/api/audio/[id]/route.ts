// GET /api/audio/[id] — serve a stored narration clip.
//
// Same-origin so the student replay <audio> loads it with no CORS and no
// storage credentials. Bytes come from the storage seam (lib/audioStore).

import { NextRequest, NextResponse } from "next/server";
import { getAudio } from "@/lib/audioStore";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const clip = await getAudio(params.id);
  if (!clip) {
    return NextResponse.json({ error: "Audio not found" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(clip.bytes), {
    status: 200,
    headers: {
      "Content-Type": clip.mimeType,
      "Content-Length": String(clip.bytes.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
    },
  });
}
