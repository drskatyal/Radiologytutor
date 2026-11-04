// /download/windows and /download/macos: redirect to the current installer
// from the downloads manifest (lib/cloud/downloads.ts). Without a published
// installer, send the reader back to the download section, which says so.

import { NextResponse, type NextRequest } from "next/server";
import { isDesktopPlatform, loadDownloadsManifest } from "@/lib/cloud/downloads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { platform: string } }) {
  if (!isDesktopPlatform(params.platform)) return NextResponse.json({ error: "Unknown platform" }, { status: 404 });
  const manifest = await loadDownloadsManifest();
  const entry = manifest?.platforms[params.platform];
  if (!entry) return NextResponse.redirect(new URL(`/?unavailable=${params.platform}#get-viewer`, req.url), 302);
  return NextResponse.redirect(entry.url, 302);
}
