// My share links: list them, or create one for a study or a collection.

import { NextResponse, type NextRequest } from "next/server";
import { HttpError, jsonError } from "@/lib/cloud/auth";
import { ownedCollection, ownedStudy, readJson, requireAccount } from "@/lib/cloud/api";
import { expiryFromChoice, newShareToken, type Share, type ShareTarget } from "@/lib/cloud/shares";
import { viewerStore } from "@/lib/cloud/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { user } = await requireAccount();
    return NextResponse.json({ shares: await viewerStore().listShares(user.id) });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireAccount();
    const body = (await readJson(req)) as Record<string, unknown>;
    let target: ShareTarget;
    if (typeof body.studyId === "string") {
      const study = await ownedStudy(body.studyId, user.id);
      if (study.status !== "ready") throw new HttpError(409, "Finish uploading the study before sharing it.");
      target = { kind: "study", studyId: study.id };
    } else if (typeof body.collectionId === "string") {
      target = { kind: "collection", collectionId: (await ownedCollection(body.collectionId, user.id)).id };
    } else {
      throw new HttpError(400, "Choose a study or a collection to share.");
    }
    const mode = body.mode === "findings" ? "findings" : body.mode === "unknown" ? "unknown" : null;
    if (!mode) throw new HttpError(400, "Choose how to share: as an unknown, or with findings.");
    let expiresAt: string | null;
    try {
      expiresAt = expiryFromChoice(typeof body.expiry === "string" ? body.expiry : "never");
    } catch {
      throw new HttpError(400, "Choose when the link expires.");
    }
    const share: Share = {
      token: newShareToken(),
      ownerId: user.id,
      target,
      mode,
      allowDownload: body.allowDownload === true,
      expiresAt,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    await viewerStore().createShare(share);
    return NextResponse.json({ share }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
