// Read, edit (title, history, findings, diagnosis, tags, markup) or delete one
// of my stored studies. Delete removes it from the archive too and revokes
// its share links.

import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/cloud/auth";
import { ownedStudy, readJson, requireAccount } from "@/lib/cloud/api";
import { invalidateAccess } from "@/lib/cloud/access";
import { archiveConfigured, deleteArchivedStudy } from "@/lib/cloud/archive";
import { deleteStudyCascade, viewerStore } from "@/lib/cloud/store";
import { parseStudyPatch } from "@/lib/cloud/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { user } = await requireAccount();
    return NextResponse.json({ study: await ownedStudy(params.id, user.id) });
  } catch (err) {
    return jsonError(err);
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { user } = await requireAccount();
    await ownedStudy(params.id, user.id);
    const patch = parseStudyPatch(await readJson(req, 1024 * 1024));
    const store = viewerStore();
    await store.patchStudy(params.id, patch);
    return NextResponse.json({ study: await store.getStudy(params.id) });
  } catch (err) {
    return jsonError(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { user } = await requireAccount();
    const study = await ownedStudy(params.id, user.id);
    const store = viewerStore();
    // Another of my records naming the same UID would lose its pixels: keep them.
    const sharedUid = (await store.listStudies(user.id)).some((s) => s.id !== study.id && s.studyInstanceUID === study.studyInstanceUID);
    if (archiveConfigured() && !sharedUid) await deleteArchivedStudy(study.studyInstanceUID);
    await deleteStudyCascade(store, study);
    invalidateAccess({ userId: user.id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
