"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button, Field, Input } from "@/components/ui";
import { api, errorText } from "@/lib/cloud/client";

export function DeviceLinkApproval({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [done, setDone] = useState<{ status: "approved" | "denied"; deviceName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answer = async (approve: boolean) => {
    setBusy(approve ? "approve" : "deny");
    setError(null);
    try {
      setDone(await api<{ status: "approved" | "denied"; deviceName: string }>("/api/desktop/link/approve", { method: "POST", json: { userCode: code, approve } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <p role="status" className="mt-6 flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-4 text-sm">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
        {done.status === "approved"
          ? `${done.deviceName} is connected. You can close this tab and return to the app.`
          : "Request declined. The desktop app was not connected."}
      </p>
    );
  }

  return (
    <form
      className="mt-6 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void answer(true);
      }}
    >
      <Field label="Code shown in the desktop app">
        {(p) => <Input {...p} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" autoComplete="off" className="font-mono tracking-widest" />}
      </Field>
      <div className="flex gap-3">
        <Button type="submit" loading={busy === "approve"} disabled={busy !== null || code.replace(/[^A-Z0-9]/gi, "").length !== 8}>
          Connect
        </Button>
        <Button type="button" variant="ghost" loading={busy === "deny"} disabled={busy !== null || !code} onClick={() => answer(false)}>
          Not me
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
