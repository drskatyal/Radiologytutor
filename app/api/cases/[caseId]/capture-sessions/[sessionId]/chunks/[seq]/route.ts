import { NextRequest, NextResponse } from "next/server";
import { requireAuthorOrg } from "@/lib/auth";
import { captureSession, putCaptureChunk, readCaptureChunk } from "@/lib/journal/storage";
import { CaptureError } from "@/lib/journal/manifest";
import { captureHttpError } from "@/lib/journal/http";
import type { CaptureChunk } from "@/lib/journal/types";
export const runtime = "nodejs";
type Context = { params: { caseId: string; sessionId: string; seq: string } };
export async function PUT(req: NextRequest, { params }: Context) {
  try {
    const orgId = await requireAuthorOrg();
    await captureSession(orgId, params.caseId, params.sessionId);
    const encoded = req.headers.get("x-capture-chunk");
    if (!encoded || encoded.length > 1024) throw new CaptureError("Capture chunk metadata required");
    const chunk = JSON.parse(encoded) as CaptureChunk;
    if (!/^\d+$/.test(params.seq) || chunk.seq !== Number(params.seq)) throw new CaptureError("Capture sequence mismatch");
    const pieces: Uint8Array[] = []; let length = 0;
    const reader = req.body?.getReader();
    if (!reader) throw new CaptureError("Capture chunk body required");
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > 16 * 1024 * 1024) { await reader.cancel(); throw new CaptureError("Capture chunk too large", 413); }
      pieces.push(part.value);
    }
    return NextResponse.json(await putCaptureChunk(orgId, params.caseId, params.sessionId, chunk, Buffer.concat(pieces)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return captureHttpError(error); }
}
export async function GET(_req: NextRequest, { params }: Context) {
  try {
    const orgId = await requireAuthorOrg();
    if (!/^\d+$/.test(params.seq)) throw new CaptureError("Invalid capture sequence");
    const retained = await readCaptureChunk(orgId, params.caseId, params.sessionId, Number(params.seq));
    return new Response(new Uint8Array(retained.bytes), { headers: { "Content-Type": retained.chunk.mime, "Cache-Control": "private, no-store" } });
  } catch (error) { return captureHttpError(error); }
}
