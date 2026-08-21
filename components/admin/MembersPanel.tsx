"use client";

import { useCallback, useEffect, useState } from "react";
import { UserPlus, Users } from "lucide-react";
import { Badge, Button, EmptyState, Field, Input, Select, Spinner, useToast } from "@/components/ui";
import type { MembershipRole } from "@/lib/types";

type MemberRow = {
  id: string;
  userId: string;
  orgId: string;
  role: MembershipRole;
  email?: string;
  name?: string;
};

const ROLE_OPTIONS: { value: MembershipRole; label: string }[] = [
  { value: "student", label: "Student" },
  { value: "author", label: "Teacher (author)" },
  { value: "admin", label: "Admin" },
  { value: "owner", label: "Owner" },
];

/** Promote learners to teachers (and other org roles) by email. */
export function MembersPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MembershipRole>("author");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/memberships");
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Failed (${res.status})`);
      }
      const data = (await res.json()) as { memberships: MemberRow[] };
      setRows(data.memberships ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load members");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onPromote(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/memberships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
      toast({ title: "Membership saved", variant: "success" });
      setEmail("");
      await load();
    } catch (err) {
      toast({
        title: "Couldn't update membership",
        description: err instanceof Error ? err.message : undefined,
        variant: "danger",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={onPromote}
        className="flex flex-col gap-3 rounded-xl border border-subtle bg-elevated p-4 sm:flex-row sm:items-end"
      >
        <Field label="Email" className="min-w-0 flex-1">
          {(props) => (
            <Input
              {...props}
              type="email"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              placeholder="teacher@hospital.edu"
              required
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Role" className="sm:w-48">
          {(props) => (
            <Select
              {...props}
              value={role}
              onChange={(ev) => setRole(ev.target.value as MembershipRole)}
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button
          type="submit"
          loading={saving}
          leadingIcon={<UserPlus className="h-4 w-4" aria-hidden="true" />}
        >
          Save role
        </Button>
      </form>

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : error ? (
        <EmptyState
          icon={<Users aria-hidden="true" />}
          title="Couldn't load members"
          description={error}
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Users aria-hidden="true" />}
          title="No memberships yet"
          description="Promote a signed-up student to teacher with the form above."
        />
      ) : (
        <ul className="divide-y divide-subtle overflow-hidden rounded-xl border border-subtle bg-elevated">
          {rows.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-primary">
                  {m.name || m.email || m.userId}
                </p>
                {m.email && (
                  <p className="truncate text-xs text-muted">{m.email}</p>
                )}
              </div>
              <Badge variant={m.role === "author" ? "info" : "neutral"}>{m.role}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
