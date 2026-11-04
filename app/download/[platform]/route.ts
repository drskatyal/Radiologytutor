// /download/windows and /download/macos: redirect to the current installer
// from the downloads manifest (lib/cloud/downloads.ts). Without a published
// installer, send the reader back to the download section, which says so.

import { NextResponse, type NextRequest } from "next/server";
import { isDesktopPlatform, loadDownloadsManifest } from "@/lib/cloud/downloads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { platform: string } }) {
  if (!isDesktopPlatform(params.platform)) return NextResponse.json({ error: "Unknown platform" }, { status: 404 });
  const manifest = await loadDownloadsManifest();
  const entry = manifest?.platforms[params.platform];
  // Relative Location: behind Cloud Run the request URL's host is the container's, not ours.
  if (!entry) return new Response(null, { status: 302, headers: { Location: `/?unavailable=${params.platform}#get-viewer` } });
  return NextResponse.redirect(entry.url, 302);
}
