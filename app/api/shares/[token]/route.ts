// Change or revoke one of my share links. Revoke is permanent: a revoked token
// never works again (create a new link instead).

import { NextResponse, type NextRequest } from "next/server";
import { HttpError, jsonError } from "@/lib/cloud/auth";
import { readJson, requireAccount } from "@/lib/cloud/api";
import { invalidateAccess } from "@/lib/cloud/access";
import { expiryFromChoice, isShareToken } from "@/lib/cloud/shares";
import { viewerStore } from "@/lib/cloud/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { token: string } };

async function ownedShare(token: string, userId: string) {
  const share = isShareToken(token) ? await viewerStore().getShare(token) : null;
  if (!share || share.ownerId !== userId) throw new HttpError(404, "Link not found.");
  return share;
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { user } = await requireAccount();
    const share = await ownedShare(params.token, user.id);
    if (share.revokedAt) throw new HttpError(409, "This link was revoked. Create a new one.");
    const body = (await readJson(req)) as Record<string, unknown>;
    const patch: { expiresAt?: string | null; allowDownload?: boolean } = {};
    if (typeof body.expiry === "string") {
      try {
        patch.expiresAt = expiryFromChoice(body.expiry);
      } catch {
        throw new HttpError(400, "Choose when the link expires.");
      }
    }
    if (typeof body.allowDownload === "boolean") patch.allowDownload = body.allowDownload;
    const store = viewerStore();
    await store.patchShare(share.token, patch);
    invalidateAccess({ shareToken: share.token });
    return NextResponse.json({ share: await store.getShare(share.token) });
  } catch (err) {
    return jsonError(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { user } = await requireAccount();
    const share = await ownedShare(params.token, user.id);
    const store = viewerStore();
    if (!share.revokedAt) await store.patchShare(share.token, { revokedAt: new Date().toISOString() });
    invalidateAccess({ shareToken: share.token });
    return NextResponse.json({ share: await store.getShare(share.token) });
  } catch (err) {
    return jsonError(err);
  }
}
