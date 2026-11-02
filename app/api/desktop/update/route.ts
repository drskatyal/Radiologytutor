import { LATEST, channelResponse, isManifest } from "@/lib/desktopChannel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Desktop updater manifest (docs/UPDATES.md). No query, no cookies, nothing
 * logged: the app sends a bare GET. 204 = no rollout in progress.
 */
export function GET() {
  return channelResponse(LATEST, isManifest);
}
