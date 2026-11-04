// Desktop sign-in, step 2: the signed-in user approves (or denies) the code
// their desktop app shows.

import { NextResponse, type NextRequest } from "next/server";
import { HttpError, jsonError } from "@/lib/cloud/auth";
import { readJson, requireAccount } from "@/lib/cloud/api";
import { deviceLinkExpired, normaliseUserCode } from "@/lib/cloud/entitlements";
import { viewerStore } from "@/lib/cloud/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireAccount();
    const body = (await readJson(req, 1024)) as { userCode?: unknown; approve?: unknown };
    const code = normaliseUserCode(body.userCode);
    if (!code) throw new HttpError(400, "Enter the 8-character code your desktop app shows.");
    const store = viewerStore();
    const link = await store.findDeviceLinkByCode(code);
    if (!link || link.status !== "pending" || deviceLinkExpired(link)) {
      throw new HttpError(404, "That code has expired or was already used. Start again from the desktop app.");
    }
    const approve = body.approve === true;
    await store.patchDeviceLink(link.pollId, approve ? { status: "approved", userId: user.id } : { status: "denied" });
    return NextResponse.json({ status: approve ? "approved" : "denied", deviceName: link.deviceName });
  } catch (err) {
    return jsonError(err);
  }
}
