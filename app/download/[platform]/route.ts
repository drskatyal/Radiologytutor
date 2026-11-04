// /download/windows and /download/macos: the stable links the site (and later
// emails) use. Today they lead to the "coming soon" section. They redirect to
// a real installer only when offeredInstaller() allows it: DESKTOP_DOWNLOADS_LIVE=1
// AND a signed, self-updating build in the manifest (lib/cloud/downloads.ts).

import { NextResponse, type NextRequest } from "next/server";
import { downloadsLive, isDesktopPlatform, loadDownloadsManifest, offeredInstaller } from "@/lib/cloud/downloads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { platform: string } }) {
  if (!isDesktopPlatform(params.platform)) return NextResponse.json({ error: "Unknown platform" }, { status: 404 });
  const manifest = downloadsLive() ? await loadDownloadsManifest() : null;
  const entry = offeredInstaller(manifest, params.platform);
  // Relative Location: behind Cloud Run the request URL's host is the container's, not ours.
  if (!entry) return new Response(null, { status: 302, headers: { Location: `/?unavailable=${params.platform}#get-viewer` } });
  return NextResponse.redirect(entry.url, 302);
}
