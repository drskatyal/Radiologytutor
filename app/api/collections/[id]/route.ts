import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/cloud/auth";
import { ownedCollection, readJson, requireAccount } from "@/lib/cloud/api";
import { invalidateAccess } from "@/lib/cloud/access";
import { viewerStore } from "@/lib/cloud/store";
import { parseCollectionPatch } from "@/lib/cloud/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { user } = await requireAccount();
    return NextResponse.json({ collection: await ownedCollection(params.id, user.id) });
  } catch (err) {
    return jsonError(err);
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { user } = await requireAccount();
    await ownedCollection(params.id, user.id);
    const patch = parseCollectionPatch(await readJson(req));
    const store = viewerStore();
    if (patch.studyIds) {
      // Only my own studies can go into my collection.
      const mine = new Set((await store.listStudies(user.id)).map((s) => s.id));
      patch.studyIds = patch.studyIds.filter((id) => mine.has(id));
    }
    await store.patchCollection(params.id, patch);
    // Collection shares grant whatever the collection holds now.
    for (const s of await store.listShares(user.id)) {
      if (s.target.kind === "collection" && s.target.collectionId === params.id) invalidateAccess({ shareToken: s.token });
    }
    return NextResponse.json({ collection: await store.getCollection(params.id) });
  } catch (err) {
    return jsonError(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { user } = await requireAccount();
    const collection = await ownedCollection(params.id, user.id);
    const store = viewerStore();
    const now = new Date().toISOString();
    for (const s of await store.listShares(user.id)) {
      if (s.target.kind === "collection" && s.target.collectionId === collection.id && !s.revokedAt) {
        await store.patchShare(s.token, { revokedAt: now });
        invalidateAccess({ shareToken: s.token });
      }
    }
    await store.deleteCollection(collection.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
