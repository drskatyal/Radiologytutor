// Public sign-up choice. Teacher and student only — never admin.
// Email sends the header on the same request. Google survives the redirect
// in a short-lived cookie. Anything else provisions a teacher.

export type PublicSignupRole = "teacher" | "student";

export const SIGNUP_INTENT_COOKIE = "flowrad_signup_intent";
export const SIGNUP_INTENT_HEADER = "x-flowrad-signup-intent";

export function parseSignupIntent(raw: string | null | undefined): PublicSignupRole {
  return raw?.trim() === "student" ? "student" : "teacher";
}

/** A value the person actually chose. Admin-shaped strings are ignored. */
export function explicitPublicRole(raw: string | null | undefined): PublicSignupRole | null {
  const value = raw?.trim();
  if (value === "student" || value === "teacher") return value;
  return null;
}

export function readSignupIntentCookie(
  cookieHeader: string | null | undefined
): PublicSignupRole | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() !== SIGNUP_INTENT_COOKIE) continue;
    try {
      return parseSignupIntent(decodeURIComponent(trimmed.slice(eq + 1).trim()));
    } catch {
      return parseSignupIntent(trimmed.slice(eq + 1).trim());
    }
  }
  return null;
}

export function intentFromCookieHeader(
  cookieHeader: string | null | undefined
): PublicSignupRole {
  return readSignupIntentCookie(cookieHeader) ?? "teacher";
}

/**
 * Header or body wins when it is exactly teacher or student.
 * A forged admin role is dropped so a real student cookie still applies.
 */
export function resolveSignupIntent(input: {
  cookieHeader?: string | null;
  headerIntent?: string | null;
  bodyIntent?: string | null;
}): PublicSignupRole {
  const explicit =
    explicitPublicRole(input.headerIntent) ?? explicitPublicRole(input.bodyIntent);
  if (explicit) return explicit;
  return intentFromCookieHeader(input.cookieHeader);
}

/** Remember the choice across the Google redirect. Same-site, ten minutes. */
export function rememberSignupIntent(role: PublicSignupRole): void {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SIGNUP_INTENT_COOKIE}=${encodeURIComponent(role)}; Path=/; Max-Age=600; SameSite=Lax${secure}`;
}
