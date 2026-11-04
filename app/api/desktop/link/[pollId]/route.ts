// Desktop sign-in, step 3: the app polls with its secret pollId. Once the user
// approved in the browser, it receives a device token exactly once.

import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/cloud/auth";
import { deviceLinkExpired, entitlementForPlan, signDeviceToken } from "@/lib/cloud/entitlements";
import { viewerStore } from "@/lib/cloud/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET(_req: NextRequest, { params }: { params: { pollId: string } }) {
  try {
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(params.pollId)) return NextResponse.json({ status: "expired" }, { status: 404, headers: noStore });
    const store = viewerStore();
    const link = await store.getDeviceLink(params.pollId);
    if (!link || link.status === "collected" || deviceLinkExpired(link)) {
      return NextResponse.json({ status: "expired" }, { status: 404, headers: noStore });
    }
    if (link.status === "denied") return NextResponse.json({ status: "denied" }, { headers: noStore });
    if (link.status === "pending" || !link.userId) return NextResponse.json({ status: "pending" }, { headers: noStore });
    const account = await store.getAccount(link.userId);
    if (!account) return NextResponse.json({ status: "expired" }, { status: 404, headers: noStore });
    await store.patchDeviceLink(link.pollId, { status: "collected" });
    return NextResponse.json(
      {
        status: "approved",
        deviceToken: signDeviceToken(account.id),
        account: { email: account.email },
        entitlement: entitlementForPlan(account.plan),
      },
      { headers: noStore }
    );
  } catch (err) {
    return jsonError(err);
  }
}
