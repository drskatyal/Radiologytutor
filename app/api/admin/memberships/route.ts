// Admin memberships — promote/demote org roles (teacher onboarding).
//
//   GET  /api/admin/memberships -> list memberships for the active org
//   POST /api/admin/memberships -> upsert { userId | email, role }

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAdminOrg } from "@/lib/auth";
import {
  createMembership,
  createUser,
  getUserByEmail,
  listMemberships,
  listUsers,
} from "@/lib/cases";
import type { MembershipRole } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES: MembershipRole[] = ["owner", "admin", "author", "student"];

function asRole(v: unknown): MembershipRole | null {
  return typeof v === "string" && (ROLES as string[]).includes(v)
    ? (v as MembershipRole)
    : null;
}

export async function GET() {
  try {
    const orgId = await requireAdminOrg();
    const [memberships, users] = await Promise.all([
      listMemberships(orgId),
      listUsers(orgId).catch(() => []),
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    return NextResponse.json({
      memberships: memberships.map((m) => ({
        ...m,
        email: byId.get(m.userId)?.email,
        name: byId.get(m.userId)?.name,
      })),
    });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}

export async function POST(req: NextRequest) {
  try {
    const orgId = await requireAdminOrg();
    const body = (await req.json()) as {
      userId?: string;
      email?: string;
      role?: string;
      name?: string;
    };
    const role = asRole(body.role);
    if (!role) {
      return NextResponse.json(
        { error: "role must be owner | admin | author | student" },
        { status: 400 }
      );
    }

    let userId = body.userId?.trim();
    if (!userId && body.email?.trim()) {
      const email = body.email.trim().toLowerCase();
      let user = await getUserByEmail(email);
      if (!user) {
        user = await createUser({
          email,
          name: body.name?.trim() || email.split("@")[0],
          role: role === "student" ? "student" : role === "admin" || role === "owner" ? "admin" : "author",
          orgId,
        });
      }
      userId = user.id;
    }
    if (!userId) {
      return NextResponse.json({ error: "userId or email is required" }, { status: 400 });
    }

    const membership = await createMembership({ userId, orgId, role });
    return NextResponse.json({ membership });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
