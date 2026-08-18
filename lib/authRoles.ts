// Pure RBAC ranking — no I/O. Used by lib/auth.ts and tests.

import type { MembershipRole, PlatformRole } from "./types";

const MEMBERSHIP_RANK: Record<MembershipRole, number> = {
  student: 1,
  author: 2,
  admin: 3,
  owner: 4,
};

export function membershipRank(role: MembershipRole): number {
  return MEMBERSHIP_RANK[role] ?? 0;
}

/** True when `have` is at least as privileged as `need` within an org. */
export function hasMembershipAccess(
  have: MembershipRole | null | undefined,
  need: MembershipRole
): boolean {
  if (!have) return false;
  return membershipRank(have) >= membershipRank(need);
}

export function isPlatformSuperAdmin(
  platformRole: PlatformRole | null | undefined
): boolean {
  return platformRole === "super_admin";
}

/**
 * Authorize a resource action: platform super-admin always wins; otherwise
 * the membership in that org must meet `need`.
 */
export function canAccessOrgResource(opts: {
  platformRole?: PlatformRole | null;
  membershipRole?: MembershipRole | null;
  need: MembershipRole;
}): boolean {
  if (isPlatformSuperAdmin(opts.platformRole)) return true;
  return hasMembershipAccess(opts.membershipRole, opts.need);
}
