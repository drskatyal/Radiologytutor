// Pure role → home path. Used by /dashboard and tests. No I/O.

import type { MembershipRole, PlatformRole } from "./types";

/**
 * Where a session should land after sign-in.
 * Returns `null` when signed in but the org role is not yet known — the
 * dashboard page then renders a stub hub with explicit links.
 */
export function dashboardPath(input: {
  signedIn: boolean;
  platformRole?: PlatformRole | null;
  membershipRole?: MembershipRole | null;
}): string | null {
  if (!input.signedIn) return "/sign-in";
  if (input.platformRole === "super_admin") return "/admin";
  switch (input.membershipRole) {
    case "owner":
    case "admin":
      return "/admin";
    case "author":
      return "/studio";
    case "student":
      return "/library";
    default:
      return null;
  }
}
