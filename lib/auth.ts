// Identity seam — Better Auth + Google OAuth.
//
// No `better-auth` imports outside this file (the catch-all route re-exports
// `authHandlers`). Domain User / Membership rows in lib/cases.ts are the RBAC
// source of truth; Better Auth is only the credential provider.
//
// Without MONGODB_URI we use the in-memory adapter so `npm run build` and
// local demo work with no database. A signed demo cookie additionally lets
// "Continue as demo" work even when the memory adapter is empty.

import { createHmac, timingSafeEqual } from "crypto";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { nextCookies, toNextJsHandler } from "better-auth/next-js";
import { MongoClient } from "mongodb";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import {
  DEFAULT_ORG_ID,
  DEMO_STUDENT_USER_ID,
  DEMO_TEACHER_USER_ID,
  DEMO_USER_ID,
  ensureDemoIdentity,
  getMembershipForUserOrg,
  getUser,
  getUserByAuthProviderId,
  getUserByEmail,
  listMembershipsForUser,
  provisionAuthUser,
} from "@/lib/cases";
import {
  canAccessOrgResource,
  isPlatformSuperAdmin,
  membershipRank,
} from "@/lib/authRoles";
import type { Membership, MembershipRole, PlatformRole, User } from "@/lib/types";

const DEMO_COOKIE = "flowrad_demo";
const DEMO_MAX_AGE_SEC = 60 * 60 * 24 * 14;

const APP_URL =
  process.env.BETTER_AUTH_URL?.trim() ||
  process.env.NEXT_PUBLIC_APP_URL?.trim() ||
  "http://localhost:3000";

/**
 * Session/demo-cookie signing key.
 *
 * There is deliberately NO usable production fallback: a hardcoded default that
 * ships in the repo lets anyone who reads it forge a cookie for any user id, so
 * a deploy that forgets the env var must fail loudly rather than quietly run
 * with a public key. Dev and `npm run build` keep a fixed dev-only value.
 */
const DEV_AUTH_SECRET = "dev-only-change-me-flowrad-learn-secret!!";

/**
 * `next build` evaluates route modules to collect page data, with NODE_ENV set
 * to production but no runtime env available. Throwing there would break the
 * build on a machine that legitimately has no secret, so the check is skipped
 * for the build phase only — a serving process still fails loudly.
 */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

function resolveAuthSecret(): string {
  const configured = process.env.BETTER_AUTH_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production" && !isBuildPhase()) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. Refusing to serve with a public signing key — " +
        "generate one with `openssl rand -base64 32` and set it in the environment."
    );
  }
  return DEV_AUTH_SECRET;
}

/**
 * Resolved per use rather than cached at module load, so the failure surfaces
 * on the first request a misconfigured server handles instead of at import
 * time (where Next would swallow it into an opaque build/collect error).
 */
function authSecret(): string {
  return resolveAuthSecret();
}

const googleId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

const memoryDb: MemoryDB = {
  user: [],
  session: [],
  account: [],
  verification: [],
};

function buildDatabase() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) return memoryAdapter(memoryDb);
  // Construct the client without connecting — first adapter op opens the pool.
  // Safe at `next build` even if MONGODB_URI is present.
  const client = new MongoClient(uri);
  const dbName = process.env.MONGODB_DB?.trim() || "flowrad";
  return mongodbAdapter(client.db(dbName), {
    client,
    transaction: false,
  });
}

export const auth = betterAuth({
  database: buildDatabase(),
  secret: resolveAuthSecret(),
  baseURL: APP_URL,
  trustedOrigins: [APP_URL, "http://localhost:3000", "http://127.0.0.1:3000"],
  telemetry: { enabled: false },
  emailAndPassword: { enabled: true },
  socialProviders:
    googleId && googleSecret
      ? {
          google: {
            clientId: googleId,
            clientSecret: googleSecret,
          },
        }
      : undefined,
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await provisionAuthUser({
            authProviderId: user.id,
            email: user.email,
            name: user.name,
            image: user.image ?? undefined,
          });
        },
      },
    },
  },
  plugins: [nextCookies()],
});

/** Next.js App Router handlers — the only thing `/api/auth/[...all]` re-exports. */
export const authHandlers = toNextJsHandler(auth);

export class AuthError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export type SessionUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  platformRole?: PlatformRole | null;
  activeOrgId: string;
  membershipRole: MembershipRole | null;
};

export type AppSession = {
  user: SessionUser;
  memberships: Membership[];
};

function pickActiveMembership(memberships: Membership[]): Membership | null {
  if (memberships.length === 0) return null;
  return memberships.slice().sort((a, b) => membershipRank(b.role) - membershipRank(a.role))[0];
}

function toSessionUser(user: User, memberships: Membership[]): SessionUser {
  const active = pickActiveMembership(memberships);
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    image: user.image ?? null,
    platformRole: user.platformRole ?? null,
    activeOrgId: active?.orgId || user.orgId || DEFAULT_ORG_ID,
    membershipRole: active?.role ?? null,
  };
}

async function domainUserFromAuth(authUser: {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
}): Promise<User> {
  const existing =
    (await getUserByAuthProviderId(authUser.id)) ?? (await getUserByEmail(authUser.email));
  if (existing) {
    if (existing.authProviderId !== authUser.id) {
      return provisionAuthUser({
        authProviderId: authUser.id,
        email: authUser.email,
        name: authUser.name ?? undefined,
        image: authUser.image ?? undefined,
      });
    }
    return existing;
  }
  return provisionAuthUser({
    authProviderId: authUser.id,
    email: authUser.email,
    name: authUser.name ?? undefined,
    image: authUser.image ?? undefined,
  });
}

function signDemoToken(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + DEMO_MAX_AGE_SEC;
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp }), "utf8").toString(
    "base64url"
  );
  const mac = createHmac("sha256", authSecret()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function verifyDemoToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", authSecret()).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: string;
      exp?: number;
    };
    if (!json.sub || typeof json.exp !== "number") return null;
    if (json.exp * 1000 < Date.now()) return null;
    return json.sub;
  } catch {
    return null;
  }
}

function demoCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: DEMO_MAX_AGE_SEC,
    secure: process.env.NODE_ENV === "production",
  };
}

async function sessionFromDomainUser(user: User): Promise<AppSession> {
  const memberships = await listMembershipsForUser(user.id);
  return { user: toSessionUser(user, memberships), memberships };
}

async function readDemoSession(): Promise<AppSession | null> {
  try {
    const jar = cookies();
    const raw = jar.get(DEMO_COOKIE)?.value;
    if (!raw) return null;
    const userId = verifyDemoToken(raw);
    if (!userId) return null;
    await ensureDemoIdentity();
    const user = await getUser(userId);
    if (!user) return null;
    return sessionFromDomainUser(user);
  } catch {
    return null;
  }
}

/** Current session or null. Safe on RSC / route handlers. */
export async function getSession(): Promise<AppSession | null> {
  try {
    const ba = await auth.api.getSession({ headers: headers() });
    if (ba?.user?.email) {
      const domain = await domainUserFromAuth({
        id: ba.user.id,
        email: ba.user.email,
        name: ba.user.name,
        image: ba.user.image,
      });
      return sessionFromDomainUser(domain);
    }
  } catch {
    // No request context, or Better Auth has no session — fall through to demo.
  }
  return readDemoSession();
}

export async function requireSession(): Promise<SessionUser> {
  const s = await getSession();
  if (!s) throw new AuthError(401, "Unauthorized");
  return s.user;
}

/** Org for data-layer calls — never take this from the client body. */
export async function activeOrgId(): Promise<string> {
  const s = await getSession();
  return s?.user.activeOrgId || DEFAULT_ORG_ID;
}

/**
 * Require a signed-in user whose membership in the active org meets `minRole`
 * (platform super-admin always passes).
 */
export async function requireRole(minRole: MembershipRole): Promise<SessionUser> {
  const user = await requireSession();
  if (isPlatformSuperAdmin(user.platformRole)) return user;
  const membership = await getMembershipForUserOrg(user.id, user.activeOrgId);
  if (
    !canAccessOrgResource({
      platformRole: user.platformRole,
      membershipRole: membership?.role ?? user.membershipRole,
      need: minRole,
    })
  ) {
    throw new AuthError(403, "Forbidden");
  }
  return user;
}

/** Active org for admin APIs — never from the client body. */
export async function requireAdminOrg(): Promise<string> {
  return (await requireRole("admin")).activeOrgId;
}

/** Active org for studio/authoring APIs — never from the client body. */
export async function requireAuthorOrg(): Promise<string> {
  return (await requireRole("author")).activeOrgId;
}

export async function requirePlatformSuperAdmin(): Promise<SessionUser> {
  const user = await requireSession();
  if (!isPlatformSuperAdmin(user.platformRole)) {
    throw new AuthError(403, "Forbidden");
  }
  return user;
}

export function toClientUser(user: SessionUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    platformRole: user.platformRole,
    activeOrgId: user.activeOrgId,
    membershipRole: user.membershipRole,
  };
}

export function googleAuthEnabled(): boolean {
  return Boolean(googleId && googleSecret);
}

export function jsonAuthError(err: unknown): NextResponse | null {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return null;
}

/** Protect a server layout/page: redirect to sign-in (or home if forbidden). */
export async function requirePageRole(
  minRole: MembershipRole,
  nextPath: string
): Promise<SessionUser> {
  const session = await getSession();
  if (!session) {
    redirect(`/sign-in?next=${encodeURIComponent(nextPath)}`);
  }
  try {
    return await requireRole(minRole);
  } catch (err) {
    if (err instanceof AuthError && err.status === 403) redirect("/");
    redirect(`/sign-in?next=${encodeURIComponent(nextPath)}`);
  }
}

export type DemoRole = "super_admin" | "author" | "student";

/**
 * Is the keyless "Continue as demo" path available?
 *
 * Off in production unless explicitly switched on. Left ungated it is a full
 * authentication bypass: an empty POST to /api/auth/demo would hand any
 * anonymous caller a platform super-admin session.
 */
export function demoAuthEnabled(): boolean {
  const flag = process.env.DEMO_AUTH_ENABLED?.trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return process.env.NODE_ENV !== "production";
}

/**
 * Highest demo role this deployment will hand out.
 *
 * Even where demo sign-in is deliberately enabled in production (a public
 * sandbox), it tops out at `author` — platform super-admin is never something
 * an unauthenticated request can mint.
 */
export function maxDemoRole(): DemoRole {
  if (process.env.NODE_ENV !== "production") return "super_admin";
  return process.env.DEMO_AUTH_MAX_ROLE?.trim() === "author" ? "author" : "student";
}

const DEMO_ROLE_RANK: Record<DemoRole, number> = {
  student: 0,
  author: 1,
  super_admin: 2,
};

/** Clamp a requested demo role to what this deployment allows. */
export function clampDemoRole(requested: DemoRole): DemoRole {
  const cap = maxDemoRole();
  return DEMO_ROLE_RANK[requested] > DEMO_ROLE_RANK[cap] ? cap : requested;
}

export async function createDemoSessionResponse(
  requestedRole: DemoRole = "super_admin"
): Promise<NextResponse> {
  if (!demoAuthEnabled()) {
    return NextResponse.json(
      { error: "Demo sign-in is disabled on this deployment." },
      { status: 404 }
    );
  }
  const role = clampDemoRole(requestedRole);
  await ensureDemoIdentity();
  const userId =
    role === "student"
      ? DEMO_STUDENT_USER_ID
      : role === "author"
        ? DEMO_TEACHER_USER_ID
        : DEMO_USER_ID;
  const user = await getUser(userId);
  if (!user) {
    return NextResponse.json({ error: "Demo identity is missing." }, { status: 500 });
  }
  const session = await sessionFromDomainUser(user);
  const res = NextResponse.json({ user: toClientUser(session.user) });
  res.cookies.set(DEMO_COOKIE, signDemoToken(user.id), demoCookieOptions());
  return res;
}

export function clearDemoSessionResponse(): NextResponse {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(DEMO_COOKIE, "", { ...demoCookieOptions(), maxAge: 0 });
  return res;
}

/** Resolve domain user from a Better Auth id or email (used by hooks / tests). */
export async function resolveDomainUser(opts: {
  authProviderId?: string;
  email?: string;
}): Promise<User | null> {
  if (opts.authProviderId) {
    const byAuth = await getUserByAuthProviderId(opts.authProviderId);
    if (byAuth) return byAuth;
  }
  if (opts.email) return getUserByEmail(opts.email);
  return null;
}
