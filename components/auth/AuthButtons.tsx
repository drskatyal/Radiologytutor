"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, cn } from "@/components/ui";
import {
  demoEntryDestination,
  demoRoleBody,
  safeNext,
  type DemoPick,
  type DemoSessionUser,
} from "@/lib/demoEntry";

export type { DemoPick };

/**
 * One demo cookie path. Teacher posts `{ role: "author" }`, Student posts
 * `{ role: "student" }`. Full navigation so the next document loads the new
 * cookie and AppShell refetches /api/me (a client transition was keeping the
 * previous persona — Teacher demo stuck on Demo Student).
 */
export async function requestDemoSession(role: DemoPick, next?: string): Promise<void> {
  const res = await fetch("/api/auth/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(demoRoleBody(role)),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Demo sign-in failed.");
  }
  const data = (await res.json()) as { user?: DemoSessionUser };
  window.location.assign(demoEntryDestination(data.user ?? {}, next));
}

export function useDemoSignIn(defaultNext?: string) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signInAs(role: DemoPick, next?: string, id?: string) {
    if (busyId) return;
    setBusyId(id ?? role);
    setError(null);
    try {
      await requestDemoSession(role, next ?? defaultNext);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demo sign-in failed.");
      setBusyId(null);
    }
  }

  return { busyId, error, signInAs };
}

export function GoogleSignInButton({
  callbackURL = "/",
}: {
  callbackURL?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: safeNext(callbackURL) || "/" }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        throw new Error(data.message || data.error || "Google sign-in is unavailable.");
      }
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        loading={busy}
        onClick={onClick}
      >
        Continue with Google
      </Button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/** Sign-in only. Includes Continue as demo, which these marketing buttons do not. */
export function DemoSignInButton({ next }: { next?: string }) {
  const { busyId, error, signInAs } = useDemoSignIn(next);

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        loading={busyId === "super_admin"}
        disabled={busyId != null && busyId !== "super_admin"}
        onClick={() => signInAs("super_admin")}
      >
        Continue as demo
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="w-full"
        loading={busyId === "author"}
        disabled={busyId != null && busyId !== "author"}
        onClick={() => signInAs("author")}
      >
        Teacher demo
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="w-full"
        loading={busyId === "student"}
        disabled={busyId != null && busyId !== "student"}
        onClick={() => signInAs("student")}
      >
        Student demo
      </Button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

/**
 * Teacher or Student in one click. Same POST as DemoSignInButton.
 * Pass `next` only for a safe in-app path (upload → /studio/new).
 */
export function DemoEntryButton({
  role,
  next,
  children,
  variant = "primary",
  size = "md",
  className,
  wrapClassName,
}: {
  role: "author" | "student";
  next?: string;
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  wrapClassName?: string;
}) {
  const { busyId, error, signInAs } = useDemoSignIn(next);
  const loading = busyId === role;

  return (
    <span className={cn("inline-flex max-w-full flex-col items-start gap-1", wrapClassName)}>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        loading={loading}
        disabled={busyId != null && !loading}
        onClick={() => signInAs(role, next, role)}
      >
        {children}
      </Button>
      {error && (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** Teacher + Student. No super-admin. Used on the landing and in the signed-out chrome. */
export function DemoRoleEntry({
  teacherLabel = "Teacher",
  studentLabel = "Student",
  teacherNext,
  studentNext,
  size = "md",
  teacherVariant = "primary",
  studentVariant = "secondary",
  className,
}: {
  teacherLabel?: string;
  studentLabel?: string;
  teacherNext?: string;
  studentNext?: string;
  size?: ButtonSize;
  teacherVariant?: ButtonVariant;
  studentVariant?: ButtonVariant;
  className?: string;
}) {
  const { busyId, error, signInAs } = useDemoSignIn();

  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size={size}
          variant={teacherVariant}
          loading={busyId === "author"}
          disabled={busyId != null && busyId !== "author"}
          onClick={() => signInAs("author", teacherNext, "author")}
        >
          {teacherLabel}
        </Button>
        <Button
          type="button"
          size={size}
          variant={studentVariant}
          loading={busyId === "student"}
          disabled={busyId != null && busyId !== "student"}
          onClick={() => signInAs("student", studentNext, "student")}
        >
          {studentLabel}
        </Button>
      </div>
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Landing hero and closing CTA. Start teaching is the teacher door.
 * Teacher and Student are the named one-click entry. Email stays a text link.
 */
export function LandingDemoEntry() {
  const { busyId, error, signInAs } = useDemoSignIn();

  return (
    <div className="flex flex-col items-start gap-4">
      <Button
        type="button"
        loading={busyId === "start-teaching"}
        disabled={busyId != null && busyId !== "start-teaching"}
        onClick={() => signInAs("author", undefined, "start-teaching")}
      >
        Start teaching
      </Button>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={busyId === "teacher"}
          disabled={busyId != null && busyId !== "teacher"}
          onClick={() => signInAs("author", undefined, "teacher")}
        >
          Teacher
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={busyId === "student"}
          disabled={busyId != null && busyId !== "student"}
          onClick={() => signInAs("student", undefined, "student")}
        >
          Student
        </Button>
      </div>
      <Link
        href="/sign-in"
        className="text-sm font-semibold text-secondary underline-offset-4 transition-colors duration-300 ease-draw hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Sign in with email
      </Link>
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" });
      await fetch("/api/auth/demo", { method: "DELETE", credentials: "include" });
      router.push("/sign-in");
      router.refresh();
      window.location.href = "/sign-in";
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      loading={busy}
      onClick={onClick}
      className={className}
    >
      Sign out
    </Button>
  );
}
