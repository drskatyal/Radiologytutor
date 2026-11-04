"use client";

// Create and manage view-only links for one study or one collection:
// unknown vs with findings, expiry, downloads, copy, embed code, revoke.

import { useEffect, useState } from "react";
import { Check, Copy, Link2, Trash2 } from "lucide-react";
import { Badge, Button, Field, IconButton, Select, useToast } from "@/components/ui";
import { api, errorText } from "@/lib/cloud/client";
import { EXPIRY_CHOICES, embedSnippet, sharePath, shareStatus, type Share, type ShareMode } from "@/lib/cloud/shares";

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function SharePanel({
  target,
  initialShares,
  disabledReason,
}: {
  target: { studyId: string } | { collectionId: string };
  initialShares: Share[];
  disabledReason?: string;
}) {
  const [shares, setShares] = useState(initialShares);
  const [mode, setMode] = useState<ShareMode>("unknown");
  const [expiry, setExpiry] = useState<string>("30d");
  const [allowDownload, setAllowDownload] = useState(false);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const { toast } = useToast();
  useEffect(() => setOrigin(window.location.origin), []);

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      toast({ title: "Could not copy", description: "Select the link and copy it by hand.", variant: "warning" });
    }
  };

  const create = async () => {
    setCreating(true);
    try {
      const { share } = await api<{ share: Share }>("/api/shares", { method: "POST", json: { ...target, mode, expiry, allowDownload } });
      setShares((s) => [share, ...s]);
      await copy(share.token, `${window.location.origin}${sharePath(share.token)}`);
      toast({ title: "Link created and copied", description: mode === "unknown" ? "Shared as an unknown: findings are hidden." : "Shared with findings.", variant: "success" });
    } catch (err) {
      toast({ title: "Could not create the link", description: errorText(err), variant: "danger" });
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: string) => {
    const before = shares;
    setShares((s) => s.map((x) => (x.token === token ? { ...x, revokedAt: new Date().toISOString() } : x)));
    try {
      await api(`/api/shares/${token}`, { method: "DELETE" });
      toast({ title: "Link revoked", description: "It stops working within a few seconds.", variant: "success" });
    } catch (err) {
      setShares(before);
      toast({ title: "Could not revoke the link", description: errorText(err), variant: "danger" });
    }
  };

  return (
    <div className="space-y-4" data-testid="share-panel">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Share as">
          {(p) => (
            <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as ShareMode)}>
              <option value="unknown">Unknown (history only)</option>
              <option value="findings">With findings and diagnosis</option>
            </Select>
          )}
        </Field>
        <Field label="Link expires">
          {(p) => (
            <Select {...p} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {EXPIRY_CHOICES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id === "never" ? "Never" : `After ${c.label}`}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} />
        Let viewers download the anonymised DICOM
      </label>
      <Button onClick={create} loading={creating} disabled={Boolean(disabledReason) || creating} leadingIcon={<Link2 className="h-4 w-4" aria-hidden />} data-testid="create-share">
        Create view-only link
      </Button>
      {disabledReason && <p className="text-xs text-warning">{disabledReason}</p>}

      {shares.length > 0 && (
        <ul className="divide-y divide-subtle rounded-xl border border-subtle" aria-label="Links">
          {shares.map((s) => {
            const status = shareStatus(s);
            const url = `${origin}${sharePath(s.token)}`;
            return (
              <li key={s.token} className="space-y-2 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={status === "active" ? "success" : "neutral"}>{status === "active" ? "Active" : status === "expired" ? "Expired" : "Revoked"}</Badge>
                  <Badge variant={s.mode === "unknown" ? "info" : "accent"}>{s.mode === "unknown" ? "Unknown" : "With findings"}</Badge>
                  {s.allowDownload && <Badge>Downloads on</Badge>}
                  <span className="ml-auto text-xs text-muted">
                    {s.expiresAt ? `${status === "expired" ? "Expired" : "Expires"} ${dateFmt.format(new Date(s.expiresAt))}` : "No expiry"}
                  </span>
                </div>
                {status === "active" && (
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-overlay px-2 py-1 text-xs">{url}</code>
                    <IconButton aria-label="Copy link" title="Copy link" size="sm" onClick={() => copy(s.token, url)}>
                      {copied === s.token ? <Check /> : <Copy />}
                    </IconButton>
                    <Button size="sm" variant="ghost" onClick={() => copy(`${s.token}-embed`, embedSnippet(origin, s.token))}>
                      {copied === `${s.token}-embed` ? "Copied" : "Embed code"}
                    </Button>
                    <IconButton aria-label="Revoke link" title="Revoke link" size="sm" onClick={() => revoke(s.token)}>
                      <Trash2 />
                    </IconButton>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
