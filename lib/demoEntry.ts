// Where a demo persona lands after POST /api/auth/demo.
// Shared by the sign-in form and the signed-out Teacher / Student entry so
// there is one cookie path and one next-path check.

import { dashboardPath } from "./dashboardPath";
import type { MembershipRole, PlatformRole } from "./types";

export type DemoPick = "super_admin" | "author" | "student";

export type DemoSessionUser = {
  platformRole?: PlatformRole | null;
  membershipRole?: MembershipRole | null;
};

/** In-app path only. Protocol-relative URLs are rejected. */
export function safeNext(next?: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "";
  return next;
}

export function homeFor(user: DemoSessionUser): string {
  return (
    dashboardPath({
      signedIn: true,
      platformRole: user.platformRole,
      membershipRole: user.membershipRole,
    }) ?? "/"
  );
}

/**
 * Body for POST /api/auth/demo.
 * Teacher is the author persona. Never send an empty body from these buttons —
 * an empty body asks for the implicit demo role, which production clamps.
 */
export function demoRoleBody(role: DemoPick): { role: DemoPick } {
  return { role };
}

/** A safe `next` wins. Otherwise the home for the user the server actually minted. */
export function demoEntryDestination(user: DemoSessionUser, next?: string | null): string {
  return safeNext(next) || homeFor(user);
}
