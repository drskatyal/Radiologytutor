"use client";

import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { Button, Field, Input } from "@/components/ui";
import type { IdentityConfig } from "@/lib/cloud/session";

type Phase = "idle" | "google" | "email" | "sent" | "completing" | "dev";

export function SignInPanel({ identity, devSignIn, next }: { identity: IdentityConfig | null; devSignIn: boolean; next: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Opened from an emailed sign-in link: finish it.
  useEffect(() => {
    if (!identity || !window.location.search.includes("oobCode")) return;
    setPhase("completing");
    import("./identityClient")
      .then((m) => m.completeEmailLink(identity, () => window.prompt("Confirm your email address to finish signing in")))
      .then((done) => (done ? window.location.assign(next) : setPhase("idle")))
      .catch(() => {
        setPhase("idle");
        setError("That sign-in link has expired or was already used. Send a new one.");
      });
  }, [identity, next]);

  const go = async (p: Phase, fn: () => Promise<void>) => {
    setError(null);
    setPhase(p);
    try {
      await fn();
    } catch (err) {
      setPhase("idle");
      const code = (err as { code?: string })?.code ?? "";
      setError(code === "auth/popup-closed-by-user" ? "The Google window was closed before signing in." : err instanceof Error ? err.message : "Sign-in failed. Try again.");
    }
  };

  if (!identity && !devSignIn) {
    return (
      <p role="alert" className="mt-6 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
        Sign-in is not configured on this server yet. The free viewer works without an account.
      </p>
    );
  }

  if (phase === "completing") {
    return <p className="mt-6 text-sm text-secondary" role="status">Finishing sign-in…</p>;
  }

  if (phase === "sent") {
    return (
      <div className="mt-6 rounded-lg border border-success/30 bg-success/10 p-4 text-sm" role="status">
        <p className="font-semibold text-success">Check your email</p>
        <p className="mt-1 text-secondary">We sent a sign-in link to {email}. Open it on this device.</p>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-4">
      {identity && (
        <>
          <Button className="w-full" size="lg" loading={phase === "google"} disabled={phase !== "idle"} onClick={() => go("google", async () => {
            const m = await import("./identityClient");
            await m.signInWithGoogle(identity);
            window.location.assign(next);
          })}>
            Continue with Google
          </Button>
          <div className="flex items-center gap-3 text-xs text-muted" aria-hidden>
            <span className="h-px flex-1 bg-subtle" />
            or
            <span className="h-px flex-1 bg-subtle" />
          </div>
        </>
      )}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (identity) {
            void go("email", async () => {
              const m = await import("./identityClient");
              await m.sendEmailLink(identity, email.trim(), next);
              setPhase("sent");
            });
          } else {
            void go("dev", async () => {
              const res = await fetch("/api/auth/dev", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              if (!res.ok) throw new Error(body.error || "Sign-in failed.");
              window.location.assign(next);
            });
          }
        }}
      >
        <Field label="Email" hint={identity ? "We’ll email you a one-time sign-in link." : "Development sign-in: no password, local only."}>
          {(p) => <Input {...p} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@hospital.org" />}
        </Field>
        <Button type="submit" variant={identity ? "secondary" : "primary"} className="w-full" leadingIcon={<Mail className="h-4 w-4" aria-hidden />} loading={phase === "email" || phase === "dev"} disabled={phase !== "idle" || !email}>
          {identity ? "Email me a sign-in link" : "Sign in (development)"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
