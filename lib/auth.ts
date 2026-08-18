// Identity seam — Better Auth + Google OAuth. No better-auth imports outside here
// (except the thin /api/auth catch-all route). Roles live in our Membership rows.

import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { memoryAdapter } from "better-auth/adapters/memory";
import { MongoClient } from "mongodb";
import { headers } from "next/headers";
import { DEFAULT_ORG_ID } from "@/lib/cases";
import {
  canAccessOrgResource,
  isPlatformSuperAdmin,
} from "@/lib/authRoles";
import type { MembershipRole, PlatformRole } from "@/lib/types";

const APP_URL =
  process.env.BETTER_AUTH_URL?.trim() ||
  process.env.NEXT_PUBLIC_APP_URL?.trim() ||
  "http://127.0.0.1:3000";

function buildDatabase() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) return memoryAdapter({});
  const client = new MongoClient(uri);
  void client.connect().catch(() => {
    /* first request may retry via driver */
  });
  const dbName = process.env.MONGODB_DB?.trim() || "flowrad";
  return mongodbAdapter(client.db(dbName), {
    client,
    transaction: false,
  });
}

const googleId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

export const auth = betterAuth({
  database: buildDatabase(),
  secret:
    process.env.BETTER_AUTH_SECRET?.trim() ||
    "dev-only-change-me-flowrad-learn-secret",
  baseURL: APP_URL,
  emailAndPassword: {
    enabled: true,
  },
  socialProviders:
    googleId && googleSecret
      ? {
          google: {
            clientId: googleId,
            clientSecret: googleSecret,
          },
        }
      : undefined,
  user: {
    additionalFields: {
      platformRole: {
        type: "string",
        required: false,
        input: false,
      },
      activeOrgId: {
        type: "string",
        required: false,
        defaultValue: DEFAULT_ORG_ID,
      },
    },
  },
});

export type SessionUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  platformRole?: PlatformRole | null;
  activeOrgId: string;
};

export type AppSession = {
  user: SessionUser;
} | null;

function mapUser(raw: {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  platformRole?: string | null;
  activeOrgId?: string | null;
}): SessionUser {
  return {
    id: raw.id,
    email: raw.email,
    name: raw.name,
    image: raw.image,
    platformRole:
      raw.platformRole === "super_admin" ? "super_admin" : null,
    activeOrgId: raw.activeOrgId?.trim() || DEFAULT_ORG_ID,
  };
}

/** Current session or null. Safe on RSC / route handlers. */
export async function getSession(): Promise<AppSession> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });
    if (!session?.user) return null;
    return { user: mapUser(session.user as Parameters<typeof mapUser>[0]) };
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<SessionUser> {
  const s = await getSession();
  if (!s) throw new Error("Unauthorized");
  return s.user;
}

/** Org for data-layer calls — never take this from the client body. */
export async function activeOrgId(): Promise<string> {
  const s = await getSession();
  return s?.user.activeOrgId || DEFAULT_ORG_ID;
}

export async function requirePlatformSuperAdmin(): Promise<SessionUser> {
  const user = await requireSession();
  if (!isPlatformSuperAdmin(user.platformRole)) {
    throw new Error("Forbidden");
  }
  return user;
}

/**
 * Check org role. Pass membershipRole from Membership lookup.
 * Super-admin always passes.
 */
export function requireRole(
  user: SessionUser,
  membershipRole: MembershipRole | null | undefined,
  need: MembershipRole
): void {
  if (
    !canAccessOrgResource({
      platformRole: user.platformRole,
      membershipRole,
      need,
    })
  ) {
    throw new Error("Forbidden");
  }
}

export function toClientUser(user: SessionUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    platformRole: user.platformRole,
    activeOrgId: user.activeOrgId,
  };
}

export function googleAuthEnabled(): boolean {
  return Boolean(googleId && googleSecret);
}
