// Desktop sign-in, step 1: the app asks for a code. No session needed. The
// app shows the code and opens /desktop/link?code=… in the user's browser.

import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/cloud/auth";
import { readJson } from "@/lib/cloud/api";
import { newDeviceLink } from "@/lib/cloud/entitlements";
import { viewerStore } from "@/lib/cloud/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await readJson(req, 2048)) as { deviceName?: unknown };
    const link = newDeviceLink(body.deviceName);
    await viewerStore().createDeviceLink(link);
    const origin = process.env.PUBLIC_ORIGIN?.trim() || "https://viewer.flowrad.ai";
    return NextResponse.json(
      {
        pollId: link.pollId,
        userCode: link.userCode,
        verifyUrl: `${origin}/desktop/link?code=${encodeURIComponent(link.userCode)}`,
        expiresAt: link.expiresAt,
        intervalSec: 5,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return jsonError(err);
  }
}
