// The signed-in desktop app's plan and feature entitlement (scaffold).
// Authorization: Bearer <device token from /api/desktop/link/<pollId>>.
// Advisory and unsigned today; nothing is gated (lib/cloud/entitlements.ts).

import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/cloud/auth";
import { bearerToken, entitlementForPlan, verifyDeviceToken } from "@/lib/cloud/entitlements";
import { viewerStore } from "@/lib/cloud/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const userId = verifyDeviceToken(bearerToken(req.headers.get("authorization")));
    if (!userId) return NextResponse.json({ error: "Sign in again from the desktop app." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    const account = await viewerStore().getAccount(userId);
    if (!account) return NextResponse.json({ error: "Account not found." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json(entitlementForPlan(account.plan), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}
