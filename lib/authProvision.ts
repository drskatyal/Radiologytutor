// What the Better Auth user.create hook calls. Email and Google both land here.
// The request may carry a student choice; it can never carry a platform role.

import { provisionAuthUser } from "./cases";
import type { User } from "./types";
import {
  SIGNUP_INTENT_COOKIE,
  SIGNUP_INTENT_HEADER,
  explicitPublicRole,
  parseSignupIntent,
  readSignupIntentCookie,
  type PublicSignupRole,
} from "./signupIntent";

function headerGet(bag: unknown, name: string): string | null {
  if (!bag || typeof bag !== "object" || !("get" in bag)) return null;
  const get = (bag as { get?: unknown }).get;
  if (typeof get !== "function") return null;
  const value = get.call(bag, name);
  return typeof value === "string" ? value : null;
}

function contextRecord(context: unknown): Record<string, unknown> | null {
  return context && typeof context === "object" ? (context as Record<string, unknown>) : null;
}

async function intentFromContext(context: unknown): Promise<PublicSignupRole> {
  const record = contextRecord(context);
  const request = contextRecord(record?.request);
  const cookieHeader =
    headerGet(request?.headers, "cookie") ?? headerGet(record?.headers, "cookie");
  const headerIntent =
    headerGet(request?.headers, SIGNUP_INTENT_HEADER) ??
    headerGet(record?.headers, SIGNUP_INTENT_HEADER);
  const body = contextRecord(record?.body);
  const bodyIntent = typeof body?.intent === "string" ? body.intent : null;

  const explicit = explicitPublicRole(headerIntent) ?? explicitPublicRole(bodyIntent);
  if (explicit) return explicit;

  const fromRequest = readSignupIntentCookie(cookieHeader);
  if (fromRequest) return fromRequest;

  try {
    const { cookies } = await import("next/headers");
    const raw = cookies().get(SIGNUP_INTENT_COOKIE)?.value;
    if (raw) return parseSignupIntent(raw);
  } catch {
    // Unit tests and non-request callers have no Next cookie jar.
  }
  return "teacher";
}

/** Provision the domain user for a Better Auth sign-up, honoring student intent. */
export async function applyAuthUserCreate(
  user: {
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
  },
  context?: unknown
): Promise<User> {
  const intent = await intentFromContext(context);
  return provisionAuthUser({
    authProviderId: user.id,
    email: user.email,
    name: user.name ?? undefined,
    image: user.image ?? undefined,
    intent,
  });
}
