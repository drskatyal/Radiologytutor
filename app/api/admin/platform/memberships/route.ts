// Change a membership's role from the platform directory.
// The membership id is the target. The client does not supply an org id.

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requirePlatformSuperAdmin } from "@/lib/auth";
import { getMembership, updateMembership } from "@/lib/cases";
import type { MembershipRole } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES: MembershipRole[] = ["owner", "admin", "author", "student"];

export async function POST(req: NextRequest) {
  try {
    await requirePlatformSuperAdmin();
    const body = (await req.json().catch(() => null)) as {
      membershipId?: unknown;
      role?: unknown;
    } | null;
    const membershipId = typeof body?.membershipId === "string" ? body.membershipId.trim() : "";
    const role =
      typeof body?.role === "string" && (ROLES as string[]).includes(body.role)
        ? (body.role as MembershipRole)
        : null;
    if (!membershipId || !role) {
      return NextResponse.json(
        { error: "membershipId and role (owner | admin | author | student) are required" },
        { status: 400 }
      );
    }
    const current = await getMembership(membershipId);
    if (!current) {
      return NextResponse.json({ error: "Membership not found." }, { status: 404 });
    }
    const membership = await updateMembership(membershipId, { role });
    return NextResponse.json({ membership });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}
