"use client";

import { useState } from "react";
import { Link2, RefreshCw, ShieldOff } from "lucide-react";
import { Button, IconButton, useToast } from "@/components/ui";

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Non-JSON bodies still need a sentence the toast can show.
  }
  if (res.status === 401 || res.status === 403) {
    return "Sign in as a teacher to share this case.";
  }
  return "The share link could not be updated.";
}

async function absoluteUrl(path: string): Promise<{ url: string; copied: boolean }> {
  const url = new URL(path, window.location.origin).toString();
  try {
    await navigator.clipboard.writeText(url);
    return { url, copied: true };
  } catch {
    return { url, copied: false };
  }
}

/**
 * Copy, rotate, and revoke a case share link.
 * Create is idempotent: the first copy mints a token and later copies reuse it.
 */
export function ShareLinkControls({
  caseId,
  initialPath,
  manage = true,
}: {
  caseId: string;
  initialPath: string | null;
  /** Rotate and revoke. Copy is always shown. */
  manage?: boolean;
}) {
  const { toast } = useToast();
  const [path, setPath] = useState(initialPath);
  const [busy, setBusy] = useState<"copy" | "rotate" | "revoke" | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  async function copy() {
    setBusy("copy");
    setConfirmRevoke(false);
    try {
      let next = path;
      if (!next) {
        const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}/share`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!res.ok) throw new Error(await readError(res));
        const data = (await res.json()) as { share: { path: string } };
        next = data.share.path;
        setPath(next);
      }
      const { url, copied } = await absoluteUrl(next);
      toast({
        variant: "success",
        title: copied ? "Link copied" : "Share link",
        description: copied
          ? "Anyone with this link can open the study in the viewer."
          : url,
      });
    } catch (err) {
      toast({
        variant: "danger",
        title: "Couldn't copy the link",
        description: err instanceof Error ? err.message : "Try again.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function rotate() {
    setBusy("rotate");
    setConfirmRevoke(false);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rotate: true }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { share: { path: string } };
      setPath(data.share.path);
      const { url, copied } = await absoluteUrl(data.share.path);
      toast({
        variant: "success",
        title: "New link ready",
        description: copied
          ? "Copied. The previous link no longer opens this study."
          : url,
      });
    } catch (err) {
      toast({
        variant: "danger",
        title: "Couldn't rotate the link",
        description: err instanceof Error ? err.message : "Try again.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (!confirmRevoke) {
      setConfirmRevoke(true);
      return;
    }
    setBusy("revoke");
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}/share`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await readError(res));
      setPath(null);
      setConfirmRevoke(false);
      toast({
        variant: "success",
        title: "Link revoked",
        description: "That URL no longer opens the study.",
      });
    } catch (err) {
      toast({
        variant: "danger",
        title: "Couldn't revoke the link",
        description: err instanceof Error ? err.message : "Try again.",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        loading={busy === "copy"}
        disabled={busy != null && busy !== "copy"}
        onClick={copy}
        leadingIcon={<Link2 className="h-3.5 w-3.5" aria-hidden="true" />}
      >
        {path ? "Copy link" : "Create link"}
      </Button>
      {manage && path ? (
        <>
          <IconButton
            type="button"
            aria-label="Rotate share link"
            title="Rotate share link"
            size="sm"
            variant="secondary"
            loading={busy === "rotate"}
            disabled={busy != null && busy !== "rotate"}
            onClick={rotate}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </IconButton>
          <Button
            type="button"
            size="sm"
            variant={confirmRevoke ? "danger" : "ghost"}
            loading={busy === "revoke"}
            disabled={busy != null && busy !== "revoke"}
            onClick={revoke}
            leadingIcon={<ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            {confirmRevoke ? "Confirm revoke" : "Revoke"}
          </Button>
        </>
      ) : null}
    </div>
  );
}
