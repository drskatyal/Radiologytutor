import { REMOTE_CONFIG, channelResponse, isEnvelope } from "@/lib/desktopChannel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Signed feature flags / paid-feature list for the desktop viewer. 204 = app defaults. */
export function GET() {
  return channelResponse(REMOTE_CONFIG, isEnvelope);
}
