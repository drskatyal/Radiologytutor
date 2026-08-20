// ============================================================================
// middleware.ts — edge guardrails for the expensive/abusable API surface.
//
// Two things nothing else in the app was doing (docs/EVALUATION.md §2.5):
//
//   1. RATE LIMITING. The AI, TTS and token-mint routes each spend real money
//      per call. Without a limiter one caller can drain the account.
//   2. BODY-SIZE CAPS. Voice routes accept base64 audio and TTS accepts free
//      text; both were unbounded, so a single request could pin a serverless
//      invocation and bill for a huge upstream call.
//
// Deliberately simple: a fixed-window counter in module memory. That is correct
// for a single long-lived server (the Fly/Railway deployment) and degrades to
// per-instance limits if we ever scale horizontally — at which point this moves
// behind Redis/Upstash. It is a floor, not a billing control; it exists so the
// *absence* of a limit is no longer the thing standing between us and a bill.
//
// Identity for the bucket is the session cookie when present, else the client
// IP. We do not read the session here — middleware runs on the edge runtime and
// the auth stack is Node-only — the route handlers still do the real authz.
// ============================================================================

import { NextResponse, type NextRequest } from "next/server";

export const config = {
  matcher: [
    "/api/tutor",
    "/api/transcribe",
    "/api/tts",
    "/api/grade-report",
    "/api/structure-finding",
    "/api/structure-session",
    "/api/audio",
    "/api/voice/realtime",
    "/api/auth/demo",
    "/api/upload",
  ],
};

/** Per-route budget: `limit` requests per `windowMs`, and a max request body. */
interface Budget {
  limit: number;
  windowMs: number;
  maxBodyBytes: number;
}

const MB = 1024 * 1024;
const MINUTE = 60_000;

/** Tuned to comfortably clear real interactive use, and nothing beyond it. */
const BUDGETS: Record<string, Budget> = {
  // A student asking questions: a handful of turns a minute.
  "/api/tutor": { limit: 20, windowMs: MINUTE, maxBodyBytes: 256 * 1024 },
  // Mic capture — base64 audio, so allow real size but bound it.
  "/api/transcribe": { limit: 20, windowMs: MINUTE, maxBodyBytes: 12 * MB },
  "/api/tts": { limit: 40, windowMs: MINUTE, maxBodyBytes: 32 * 1024 },
  "/api/grade-report": { limit: 10, windowMs: MINUTE, maxBodyBytes: 128 * 1024 },
  // Authoring: dictation in, structured JSON out.
  "/api/structure-finding": { limit: 20, windowMs: MINUTE, maxBodyBytes: 12 * MB },
  "/api/structure-session": { limit: 10, windowMs: MINUTE, maxBodyBytes: 48 * MB },
  "/api/audio": { limit: 30, windowMs: MINUTE, maxBodyBytes: 48 * MB },
  // Token mint — one per session turn is plenty.
  "/api/voice/realtime": { limit: 10, windowMs: MINUTE, maxBodyBytes: 4 * 1024 },
  // Credential-adjacent: keep the attempt rate low.
  "/api/auth/demo": { limit: 10, windowMs: 5 * MINUTE, maxBodyBytes: 4 * 1024 },
  // DICOM upload is large by nature; the cap is a sanity bound, not a quota.
  "/api/upload": { limit: 20, windowMs: 5 * MINUTE, maxBodyBytes: 512 * MB },
};

const DEFAULT_BUDGET: Budget = { limit: 60, windowMs: MINUTE, maxBodyBytes: MB };

interface CounterWindow {
  count: number;
  resetAt: number;
}

const windows = new Map<string, CounterWindow>();

/** Drop expired windows so the map cannot grow without bound. */
function sweep(now: number): void {
  if (windows.size < 10_000) return;
  for (const [key, w] of windows) {
    if (w.resetAt <= now) windows.delete(key);
  }
}

/**
 * Best-effort caller identity. The session cookie is stable per signed-in user;
 * otherwise fall back to the forwarded client IP. Neither is spoof-proof, which
 * is why this is a cost guardrail and not an authorization boundary.
 */
function callerKey(req: NextRequest): string {
  const cookie =
    req.cookies.get("flowrad_demo")?.value ??
    req.cookies.get("better-auth.session_token")?.value ??
    req.cookies.get("__Secure-better-auth.session_token")?.value;
  if (cookie) return `s:${cookie.slice(0, 48)}`;
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${fwd || req.headers.get("x-real-ip") || "unknown"}`;
}

function budgetFor(pathname: string): Budget {
  return BUDGETS[pathname] ?? DEFAULT_BUDGET;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const budget = budgetFor(pathname);

  // 1. Body-size cap — reject before the handler reads (and before we pay to
  //    forward it upstream). A missing Content-Length is let through; the
  //    platform enforces its own hard ceiling.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > budget.maxBodyBytes) {
    return NextResponse.json(
      { error: "Request body too large.", maxBytes: budget.maxBodyBytes },
      { status: 413 }
    );
  }

  // 2. Fixed-window rate limit.
  const now = Date.now();
  sweep(now);
  const key = `${pathname} ${callerKey(req)}`;
  const existing = windows.get(key);
  const win =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + budget.windowMs };
  win.count += 1;
  windows.set(key, win);

  const remaining = Math.max(0, budget.limit - win.count);
  const retryAfterSec = Math.max(1, Math.ceil((win.resetAt - now) / 1000));

  if (win.count > budget.limit) {
    return NextResponse.json(
      { error: "Too many requests — slow down and try again shortly." },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfterSec),
          "RateLimit-Limit": String(budget.limit),
          "RateLimit-Remaining": "0",
          "RateLimit-Reset": String(retryAfterSec),
        },
      }
    );
  }

  const res = NextResponse.next();
  res.headers.set("RateLimit-Limit", String(budget.limit));
  res.headers.set("RateLimit-Remaining", String(remaining));
  res.headers.set("RateLimit-Reset", String(retryAfterSec));
  return res;
}
