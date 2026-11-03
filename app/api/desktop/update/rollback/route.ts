import { ROLLBACK, channelResponse, isManifest } from "@/lib/desktopChannel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The previous release's manifest, fetched only by a version that failed to start. */
export function GET() {
  return channelResponse(ROLLBACK, isManifest);
}
