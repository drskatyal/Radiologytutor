"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { IconButton, useToast } from "@/components/ui";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  return (
      <IconButton
        aria-label="Sign out"
        title="Sign out"
        loading={busy}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await fetch("/api/auth/session", { method: "DELETE" });
            // Identity Platform keeps its own browser session; end it too when loaded.
            try {
              const { signOutIdentity } = await import("./identityClient");
              await signOutIdentity();
            } catch {
              /* not configured (dev sign-in) */
            }
            window.location.assign("/");
          } catch {
            setBusy(false);
            toast({ title: "Could not sign out", description: "Check your connection and try again.", variant: "danger" });
          }
        }}
      >
        <LogOut />
      </IconButton>
  );
}
