// List my stored studies / start storing a new one (quota-checked).

import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/cloud/auth";
import { readJson, requireAccount } from "@/lib/cloud/api";
import { invalidateAccess } from "@/lib/cloud/access";
import { checkStudyQuota, planById } from "@/lib/cloud/plans";
import { newId, viewerStore } from "@/lib/cloud/store";
import { parseNewStudy } from "@/lib/cloud/studyInput";
import type { Study } from "@/lib/cloud/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { user } = await requireAccount();
    return NextResponse.json({ studies: await viewerStore().listStudies(user.id) });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user, account } = await requireAccount();
    const input = parseNewStudy(await readJson(req));
    if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 });
    const store = viewerStore();
    const mine = await store.listStudies(user.id);

    // The same study again (same account salt → same anonymised UID): resume it.
    const existing = mine.find((s) => s.studyInstanceUID === input.studyInstanceUID);
    if (existing) return NextResponse.json({ study: existing, resumed: true });

    const quota = checkStudyQuota(account.plan, mine.length);
    if (!quota.ok) {
      const plan = planById(account.plan);
      return NextResponse.json(
        { error: `Your ${plan.name} plan stores ${plan.studyLimit} studies. Delete one or change plan to store more.`, quota },
        { status: 402 }
      );
    }
    const now = new Date().toISOString();
    const study: Study = {
      id: newId(),
      ownerId: user.id,
      studyInstanceUID: input.studyInstanceUID,
      status: "uploading",
      title: input.title,
      modality: input.modality,
      description: input.description,
      series: input.series,
      instanceCount: input.instanceCount,
      bytes: input.bytes,
      history: "",
      findings: "",
      diagnosis: "",
      tags: [],
      markup: [],
      createdAt: now,
      updatedAt: now,
    };
    await store.createStudy(study);
    invalidateAccess({ userId: user.id });
    return NextResponse.json({ study }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
