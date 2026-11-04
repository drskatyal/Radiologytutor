// The signed-in account: plan, usage, and the anonymisation salt. Never cached.

import { NextResponse } from "next/server";
import { jsonError } from "@/lib/cloud/auth";
import { requireAccount } from "@/lib/cloud/api";
import { checkStudyQuota, planById } from "@/lib/cloud/plans";
import { viewerStore } from "@/lib/cloud/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { user, account } = await requireAccount();
    const used = (await viewerStore().listStudies(user.id)).length;
    const plan = planById(account.plan);
    return NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name ?? null },
      plan: { id: plan.id, name: plan.name },
      quota: checkStudyQuota(plan.id, used, 0),
      // The owner's own anonymisation salt: the browser needs it to remap UIDs
      // the same way on every upload (a re-upload resumes, never duplicates).
      uidSalt: account.uidSalt,
    });
  } catch (err) {
    return jsonError(err);
  }
}
