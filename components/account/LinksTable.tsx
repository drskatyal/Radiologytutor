"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Button, useToast } from "@/components/ui";
import { api, errorText } from "@/lib/cloud/client";
import { sharePath, shareStatus, type Share } from "@/lib/cloud/shares";

type Row = Share & { targetName: string; href: string };
const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function LinksTable({ initial }: { initial: Row[] }) {
  const [rows, setRows] = useState(initial);
  const { toast } = useToast();
  const revoke = async (token: string) => {
    const before = rows;
    setRows((r) => r.map((x) => (x.token === token ? { ...x, revokedAt: new Date().toISOString() } : x)));
    try {
      await api(`/api/shares/${token}`, { method: "DELETE" });
      toast({ title: "Link revoked", variant: "success" });
    } catch (err) {
      setRows(before);
      toast({ title: "Could not revoke", description: errorText(err), variant: "danger" });
    }
  };
  return (
    <div className="mt-6 overflow-x-auto rounded-xl border border-subtle bg-surface">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-subtle text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-3 font-semibold">Shared</th>
            <th className="px-4 py-3 font-semibold">As</th>
            <th className="px-4 py-3 font-semibold">Status</th>
            <th className="px-4 py-3 font-semibold">Expires</th>
            <th className="px-4 py-3">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-subtle">
          {rows.map((r) => {
            const status = shareStatus(r);
            return (
              <tr key={r.token}>
                <td className="px-4 py-3">
                  <Link href={r.href} className="font-medium hover:text-accent">
                    {r.targetName}
                  </Link>
                </td>
                <td className="px-4 py-3">{r.mode === "unknown" ? "Unknown" : "With findings"}{r.allowDownload ? " · downloads" : ""}</td>
                <td className="px-4 py-3">
                  <Badge variant={status === "active" ? "success" : "neutral"}>{status === "active" ? "Active" : status === "expired" ? "Expired" : "Revoked"}</Badge>
                </td>
                <td className="px-4 py-3 tabular-nums text-secondary">{r.expiresAt ? dateFmt.format(new Date(r.expiresAt)) : "Never"}</td>
                <td className="px-4 py-3 text-right">
                  {status === "active" && (
                    <div className="flex justify-end gap-2">
                      <a href={sharePath(r.token)} target="_blank" rel="noreferrer" className="rounded px-2 py-1 text-xs font-semibold text-accent hover:underline">
                        Open
                      </a>
                      <Button size="sm" variant="ghost" onClick={() => revoke(r.token)}>
                        Revoke
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
