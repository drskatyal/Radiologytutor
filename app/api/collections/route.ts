import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/cloud/auth";
import { readJson, requireAccount } from "@/lib/cloud/api";
import { newId, viewerStore } from "@/lib/cloud/store";
import { parseCollectionPatch, type Collection } from "@/lib/cloud/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { user } = await requireAccount();
    return NextResponse.json({ collections: await viewerStore().listCollections(user.id) });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireAccount();
    const patch = parseCollectionPatch(await readJson(req));
    const store = viewerStore();
    const mine = new Set((await store.listStudies(user.id)).map((s) => s.id));
    const now = new Date().toISOString();
    const collection: Collection = {
      id: newId(),
      ownerId: user.id,
      name: patch.name ?? "Untitled collection",
      description: patch.description ?? "",
      studyIds: (patch.studyIds ?? []).filter((id) => mine.has(id)),
      createdAt: now,
      updatedAt: now,
    };
    await store.createCollection(collection);
    return NextResponse.json({ collection }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
