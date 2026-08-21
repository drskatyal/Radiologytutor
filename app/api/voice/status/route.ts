// GET  /api/voice/status  — which providers are configured + Live capability

import { NextResponse } from "next/server";
import { voiceStackStatus } from "@/lib/voice";
import { getRealtimeVoiceInfo } from "@/lib/voiceRealtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    stack: voiceStackStatus(),
    realtime: getRealtimeVoiceInfo(),
  });
}
