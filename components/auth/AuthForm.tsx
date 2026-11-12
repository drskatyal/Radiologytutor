"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Field, Input, useToast } from "@/components/ui";
import { DemoSignInButton, GoogleSignInButton } from "./AuthButtons";
import { dashboardPath } from "@/lib/dashboardPath";
import { safeNext } from "@/lib/demoEntry";
import {
  SIGNUP_INTENT_HEADER,
  rememberSignupIntent,
  type PublicSignupRole,
} from "@/lib/signupIntent";
import { cn } from "@/components/ui";
import type { MembershipRole, PlatformRole } from "@/lib/types";

const ROLES: { value: PublicSignupRole; label: string; detail: string }[] = [
  { value: "teacher", label: "Teacher", detail: "Record cases" },
  { value: "student", label: "Student", detail: "Learn from published cases" },
];

function authPath(path: "/sign-in" | "/sign-up", role: PublicSignupRole, next?: string) {
  const params = new URLSearchParams();
  params.set("role", role);
  if (next) params.set("next", next);
  return `${path}?${params.toString()}`;
}

export function AuthForm({
  mode,
  googleEnabled,
  demoEnabled,
  next,
  initialRole = "teacher",
}: {
  mode: "sign-in" | "sign-up";
  googleEnabled: boolean;
  /** Keyless demo sign-in — off in production unless DEMO_AUTH_ENABLED is set. */
  demoEnabled: boolean;
  next?: string;
  /** Teacher or student. Ignored for an account that already has a membership. */
  initialRole?: PublicSignupRole;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<PublicSignupRole>(initialRole);
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
    rememberSignupIntent(role);
    try {
      const path =
        mode === "sign-up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";
      const body =
        mode === "sign-up"
          ? { email, password, name: name || email.split("@")[0], callbackURL: dest || "/" }
          : { email, password, callbackURL: dest || "/" };
      const res = await fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SIGNUP_INTENT_HEADER]: role,
        },
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
        Teachers record cases. Students learn from published cases.
      </p>

      <RoleChoice role={role} onChange={setRole} />
      {mode === "sign-in" && (
        <p className="mt-2 text-xs text-muted text-pretty">
          This choice applies when the account is created. Signing in keeps the role you already have.
        </p>
      )}

      {googleEnabled && (
        <div className="mt-6">
          <GoogleSignInButton callbackURL={dest} intent={role} />
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
              href={authPath("/sign-in", role, dest || undefined)}
              className="text-accent hover:underline"
            >
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{" "}
            <Link
              href={authPath("/sign-up", role, dest || undefined)}
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

function RoleChoice({
  role,
  onChange,
}: {
  role: PublicSignupRole;
  onChange: (role: PublicSignupRole) => void;
}) {
  return (
    <fieldset className="mt-6">
      <legend className="text-sm font-semibold text-primary">I am a</legend>
      <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Teacher or student">
        {ROLES.map((option) => {
          const selected = role === option.value;
          return (
            <label
              key={option.value}
              className={cn(
                "cursor-pointer rounded-lg border px-3 py-2.5 text-left transition-colors",
                "focus-within:ring-2 focus-within:ring-accent",
                selected
                  ? "border-accent bg-accent/10"
                  : "border-subtle bg-elevated hover:border-strong"
              )}
            >
              <input
                type="radio"
                name="account-role"
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              <span className="block text-sm font-semibold text-primary">{option.label}</span>
              <span className="mt-0.5 block text-xs text-secondary">{option.detail}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
