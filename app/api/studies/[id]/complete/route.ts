// Mark an upload finished: the archive must hold at least one instance of the
// study. The stored series list is taken from the archive, not the client.

import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/cloud/auth";
import { ownedStudy, requireAccount } from "@/lib/cloud/api";
import { invalidateAccess } from "@/lib/cloud/access";
import { listStudyInstances } from "@/lib/cloud/archive";
import { viewerStore } from "@/lib/cloud/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { user } = await requireAccount();
    const study = await ownedStudy(params.id, user.id);
    const stored = await listStudyInstances(study.studyInstanceUID);
    if (!stored.length) {
      return NextResponse.json({ error: "No images of this study reached storage. Upload again." }, { status: 409 });
    }
    const counts = new Map<string, number>();
    for (const r of stored) counts.set(r.series, (counts.get(r.series) ?? 0) + 1);
    const series = study.series
      .filter((s) => counts.has(s.seriesInstanceUID))
      .map((s) => ({ ...s, instanceCount: counts.get(s.seriesInstanceUID)! }));
    const store = viewerStore();
    await store.patchStudy(study.id, { status: "ready", series, instanceCount: stored.length });
    invalidateAccess({ userId: user.id });
    return NextResponse.json({ study: await store.getStudy(study.id), missing: study.instanceCount - stored.length });
  } catch (err) {
    return jsonError(err);
  }
}
