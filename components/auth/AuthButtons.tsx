"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { dashboardPath } from "@/lib/dashboardPath";
import type { MembershipRole, PlatformRole } from "@/lib/types";

type DemoPick = "super_admin" | "author" | "student";

function safeNext(next?: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "";
  return next;
}

function homeFor(user: {
  platformRole?: PlatformRole | null;
  membershipRole?: MembershipRole | null;
}): string {
  return (
    dashboardPath({
      signedIn: true,
      platformRole: user.platformRole,
      membershipRole: user.membershipRole,
    }) ?? "/"
  );
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

export function DemoSignInButton({ next }: { next?: string }) {
  const router = useRouter();
  const [busyRole, setBusyRole] = useState<DemoPick | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signInAs(role: DemoPick) {
    if (busyRole) return;
    setBusyRole(role);
    setError(null);
    try {
      const dest = safeNext(next);
      const res = await fetch("/api/auth/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Demo sign-in failed.");
      }
      const data = (await res.json()) as {
        user?: {
          platformRole?: PlatformRole | null;
          membershipRole?: MembershipRole | null;
        };
      };
      router.push(dest || homeFor(data.user ?? {}));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demo sign-in failed.");
      setBusyRole(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        loading={busyRole === "super_admin"}
        disabled={busyRole != null && busyRole !== "super_admin"}
        onClick={() => signInAs("super_admin")}
      >
        Continue as demo
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="w-full"
        loading={busyRole === "author"}
        disabled={busyRole != null && busyRole !== "author"}
        onClick={() => signInAs("author")}
      >
        Teacher demo
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="w-full"
        loading={busyRole === "student"}
        disabled={busyRole != null && busyRole !== "student"}
        onClick={() => signInAs("student")}
      >
        Student demo
      </Button>
      {error && <p className="text-xs text-danger">{error}</p>}
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
