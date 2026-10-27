"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Field, Input, useToast } from "@/components/ui";
import { DemoSignInButton, GoogleSignInButton } from "./AuthButtons";
import { dashboardPath } from "@/lib/dashboardPath";
import { safeNext } from "@/lib/demoEntry";
import type { MembershipRole, PlatformRole } from "@/lib/types";

export function AuthForm({
  mode,
  googleEnabled,
  demoEnabled,
  next,
}: {
  mode: "sign-in" | "sign-up";
  googleEnabled: boolean;
  /** Keyless demo sign-in — off in production unless DEMO_AUTH_ENABLED is set. */
  demoEnabled: boolean;
  next?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dest = safeNext(next);

  function validate(): boolean {
    const nextNameError =
      mode === "sign-up" && !name.trim() ? "Enter your name." : null;
    const nextEmailError = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
      ? null
      : "Enter a valid email address.";
    const nextPasswordError =
      password.length >= 8 ? null : "Use at least 8 characters.";
    setNameError(nextNameError);
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    return !nextNameError && !nextEmailError && !nextPasswordError;
  }

  async function onEmail(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!validate()) return;
    setBusy(true);
    try {
      const path =
        mode === "sign-up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";
      const body =
        mode === "sign-up"
          ? { email, password, name: name || email.split("@")[0], callbackURL: dest || "/" }
          : { email, password, callbackURL: dest || "/" };
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        throw new Error(data.message || data.error || "Authentication failed");
      }
      if (dest) {
        router.push(dest);
      } else {
        const me = await fetch("/api/me");
        const payload = (await me.json().catch(() => ({}))) as {
          user?: {
            platformRole?: PlatformRole | null;
            membershipRole?: MembershipRole | null;
          };
        };
        router.push(
          dashboardPath({
            signedIn: true,
            platformRole: payload.user?.platformRole,
            membershipRole: payload.user?.membershipRole,
          }) ?? "/"
        );
      }
      router.refresh();
    } catch (err) {
      toast({
        title: mode === "sign-up" ? "Could not sign up" : "Could not sign in",
        description: err instanceof Error ? err.message : undefined,
        variant: "danger",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="text-2xl font-semibold tracking-tight text-primary text-balance">
        {mode === "sign-up" ? "Create your account" : "Sign in"}
      </h1>
      <p className="mt-2 text-sm text-secondary text-pretty">
        {mode === "sign-up"
          ? "Create a teacher account to record a case. No card is required."
          : "Sign in to teach, or to continue a case."}
      </p>

      {googleEnabled && (
        <div className="mt-6">
          <GoogleSignInButton callbackURL={dest} />
        </div>
      )}

      {mode === "sign-in" && demoEnabled && (
        <div className={googleEnabled ? "mt-3" : "mt-6"}>
          <DemoSignInButton next={dest} />
        </div>
      )}

      <div className="relative my-6">
        <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px bg-overlay" />
        <span className="relative mx-auto block w-fit bg-elevated px-2 text-[11px] font-medium uppercase tracking-wider text-muted">
          Email
        </span>
      </div>

      <form onSubmit={onEmail} className="flex flex-col gap-3">
        {mode === "sign-up" && (
          <Field label="Name" required error={nameError ?? undefined}>
            {(p) => (
              <Input
                {...p}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (nameError) setNameError(null);
                }}
                autoComplete="name"
                required
              />
            )}
          </Field>
        )}
        <Field label="Email" required error={emailError ?? undefined}>
          {(p) => (
            <Input
              {...p}
              type="email"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (emailError) setEmailError(null);
              }}
              autoComplete="email"
            />
          )}
        </Field>
        <Field label="Password" required error={passwordError ?? undefined}>
          {(p) => (
            <Input
              {...p}
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (passwordError) setPasswordError(null);
              }}
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            />
          )}
        </Field>
        <Button type="submit" loading={busy} className="w-full">
          {mode === "sign-up" ? "Create account" : "Sign in"}
        </Button>
      </form>

      <p className="mt-4 text-center text-xs text-muted">
        {mode === "sign-up" ? (
          <>
            Already have an account?{" "}
            <Link
              href={next ? `/sign-in?next=${encodeURIComponent(dest)}` : "/sign-in"}
              className="text-accent hover:underline"
            >
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{" "}
            <Link
              href={next ? `/sign-up?next=${encodeURIComponent(dest)}` : "/sign-up"}
              className="text-accent hover:underline"
            >
              Create an account
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
