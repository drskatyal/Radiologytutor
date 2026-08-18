"use client";

// Sign-in / sign-up — Google when configured; email+password always.
// Calls Better Auth HTTP API (no better-auth/react required).

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Field, Input, useToast } from "@/components/ui";

export function AuthForm({
  mode,
  googleEnabled,
}: {
  mode: "sign-in" | "sign-up";
  googleEnabled: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function onEmail(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const path =
        mode === "sign-up"
          ? "/api/auth/sign-up/email"
          : "/api/auth/sign-in/email";
      const body =
        mode === "sign-up"
          ? { email, password, name: name || email.split("@")[0] }
          : { email, password };
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || "Authentication failed");
      }
      router.push("/dashboard");
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

  function onGoogle() {
    window.location.href = "/api/auth/sign-in/social?provider=google";
  }

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-primary">
        {mode === "sign-up" ? "Create your account" : "Sign in"}
      </h1>
      <p className="mt-1.5 text-sm text-secondary">
        {mode === "sign-up"
          ? "Teach or learn on FlowRad — Google is the most secure option."
          : "Welcome back to the reading room."}
      </p>

      {googleEnabled && (
        <Button
          type="button"
          variant="secondary"
          className="mt-6 w-full"
          onClick={onGoogle}
        >
          Continue with Google
        </Button>
      )}

      <form onSubmit={onEmail} className="mt-6 flex flex-col gap-3">
        {mode === "sign-up" && (
          <Field label="Name">
            {(p) => (
              <Input
                {...p}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            )}
          </Field>
        )}
        <Field label="Email" required>
          {(p) => (
            <Input
              {...p}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          )}
        </Field>
        <Field label="Password" required>
          {(p) => (
            <Input
              {...p}
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={
                mode === "sign-up" ? "new-password" : "current-password"
              }
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
            <Link href="/sign-in" className="text-accent hover:underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{" "}
            <Link href="/sign-up" className="text-accent hover:underline">
              Create an account
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
