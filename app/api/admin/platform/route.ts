// Platform directory — every teacher, org, case, and learner.
//
//   GET  /api/admin/platform  -> cross-org directory
//   POST /api/admin/platform  -> grant platform super_admin to an existing email
//
// Org admins do not pass requirePlatformSuperAdmin, so they cannot read another
// teacher's drafts through this route. There is no public sign-up role for it.

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requirePlatformSuperAdmin } from "@/lib/auth";
import {
  AccountNotFoundError,
  getPlatformDirectory,
  grantPlatformAdminByEmail,
} from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requirePlatformSuperAdmin();
    return NextResponse.json(await getPlatformDirectory());
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}

export async function POST(req: NextRequest) {
  try {
    await requirePlatformSuperAdmin();
    const body = (await req.json().catch(() => null)) as { email?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email : "";
    if (!email.trim()) {
      return NextResponse.json({ error: "email is required" }, { status: 400 });
    }
    const user = await grantPlatformAdminByEmail(email);
    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        platformRole: user.platformRole ?? null,
      },
    });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    if (err instanceof AccountNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
