"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, ScanSearch, ShieldCheck, UserPlus, Users, Wallet } from "lucide-react";
import { Badge, Button, EmptyState, Field, Input, Panel, Select, Spinner, useToast } from "@/components/ui";
import type { MembershipRole } from "@/lib/types";

type TeacherRow = {
  userId: string;
  email: string;
  name?: string;
  orgId: string;
  orgName: string;
  role: MembershipRole;
  draftCases: number;
  publishedCases: number;
  findingCount: number;
};

type MemberRow = {
  membershipId: string;
  userId: string;
  email?: string;
  name?: string;
  orgId: string;
  orgName: string;
  role: MembershipRole;
};

type CaseRow = {
  caseId: string;
  title: string;
  status: "draft" | "published";
  orgId: string;
  orgName: string;
  findingCount: number;
  updatedAt?: string;
};

type Directory = {
  teachers: TeacherRow[];
  members: MemberRow[];
  cases: CaseRow[];
  activity: {
    teacherCount: number;
    studentCount: number;
    orgCount: number;
    draftCases: number;
    publishedCases: number;
    findingCount: number;
    enrollmentCount: number;
    progressCount: number;
  };
};

const ROLE_OPTIONS: { value: MembershipRole; label: string }[] = [
  { value: "student", label: "Student" },
  { value: "author", label: "Teacher" },
  { value: "admin", label: "Org admin" },
  { value: "owner", label: "Owner" },
];

/**
 * Platform staff see every teacher and org. An org admin gets the orientation
 * only — the directory route refuses anyone who is not platform super_admin.
 */
export function PlatformPanel() {
  const { toast } = useToast();
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [granting, setGranting] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/platform");
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        setDirectory(null);
        return;
      }
      const body = (await res.json().catch(() => null)) as (Directory & { error?: string }) | null;
      if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
      setForbidden(false);
      setDirectory(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the platform");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onGrant(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setGranting(true);
    try {
      const res = await fetch("/api/admin/platform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
      toast({
        title: "Platform admin granted",
        description: "They sign in with their existing account and land in admin.",
        variant: "success",
      });
      setEmail("");
      await load();
    } catch (err) {
      toast({
        title: "Couldn't grant platform admin",
        description: err instanceof Error ? err.message : undefined,
        variant: "danger",
      });
    } finally {
      setGranting(false);
    }
  }

  async function onRole(membershipId: string, role: MembershipRole) {
    setSavingId(membershipId);
    try {
      const res = await fetch("/api/admin/platform/memberships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ membershipId, role }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
      toast({ title: "Membership updated", variant: "success" });
      await load();
    } catch (err) {
      toast({
        title: "Couldn't update membership",
        description: err instanceof Error ? err.message : undefined,
        variant: "danger",
      });
    } finally {
      setSavingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (forbidden) return <PlatformOrientation />;

  if (error || !directory) {
    return (
      <EmptyState
        icon={<Users aria-hidden="true" />}
        title="Couldn't load the platform"
        description={error || "Try again."}
        action={
          <Button variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        }
      />
    );
  }

  const { activity } = directory;

  return (
    <div className="flex flex-col gap-8">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Teachers" value={activity.teacherCount} />
        <Stat label="Students" value={activity.studentCount} />
        <Stat label="Orgs" value={activity.orgCount} />
        <Stat label="Findings" value={activity.findingCount} />
        <Stat label="Draft cases" value={activity.draftCases} />
        <Stat label="Published" value={activity.publishedCases} />
        <Stat label="Enrollments" value={activity.enrollmentCount} />
        <Stat label="Progress" value={activity.progressCount} />
      </dl>

      <form
        onSubmit={onGrant}
        className="flex flex-col gap-3 rounded-xl border border-subtle bg-elevated p-4 sm:flex-row sm:items-end"
      >
        <Field
          label="Grant platform admin"
          hint="They must already have an account. This is not a public sign-up."
          className="min-w-0 flex-1"
        >
          {(props) => (
            <Input
              {...props}
              type="email"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              placeholder="admin@hospital.edu"
              required
              autoComplete="off"
            />
          )}
        </Field>
        <Button type="submit" loading={granting} leadingIcon={<UserPlus className="h-4 w-4" aria-hidden="true" />}>
          Grant access
        </Button>
      </form>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-primary">Teachers and their orgs</h2>
        {directory.teachers.length === 0 ? (
          <EmptyState icon={<Users aria-hidden="true" />} title="No teachers yet" description="A teacher account creates a personal org." />
        ) : (
          <ul className="divide-y divide-subtle overflow-hidden rounded-xl border border-subtle bg-elevated">
            {directory.teachers.map((teacher) => (
              <li key={`${teacher.userId}:${teacher.orgId}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-primary">{teacher.name || teacher.email || teacher.userId}</p>
                  <p className="truncate text-xs text-muted">
                    {teacher.email || "No email"} · {teacher.orgName}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="info">{teacher.role}</Badge>
                  <span className="text-xs text-secondary">
                    {teacher.publishedCases} published · {teacher.draftCases} draft · {teacher.findingCount} findings
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-primary">Members</h2>
        <ul className="divide-y divide-subtle overflow-hidden rounded-xl border border-subtle bg-elevated">
          {directory.members.map((member) => (
            <li key={member.membershipId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-primary">{member.name || member.email || member.userId}</p>
                <p className="truncate text-xs text-muted">
                  {member.email || "No email"} · {member.orgName}
                </p>
              </div>
              <div className="w-40">
                <Select
                  aria-label={`Role for ${member.email || member.name || "member"}`}
                  value={member.role}
                  disabled={savingId === member.membershipId}
                  onChange={(ev) => void onRole(member.membershipId, ev.target.value as MembershipRole)}
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-primary">Cases</h2>
        <p className="text-xs text-muted">Includes other teachers&apos; drafts. Students and ordinary teachers do not see those.</p>
        <ul className="max-h-96 divide-y divide-subtle overflow-auto rounded-xl border border-subtle bg-elevated">
          {directory.cases.map((row) => (
            <li key={row.caseId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-primary">{row.title}</p>
                <p className="truncate text-xs text-muted">
                  {row.orgName} · {row.findingCount} findings
                </p>
              </div>
              <Badge variant={row.status === "published" ? "success" : "warning"}>{row.status}</Badge>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-subtle bg-elevated px-4 py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-primary">{value}</dd>
    </div>
  );
}

function PlatformOrientation() {
  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 sm:grid-cols-2">
        <Panel
          title={
            <span className="inline-flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-accent" aria-hidden="true" />
              Org admin
            </span>
          }
        >
          <p className="text-sm font-semibold text-primary">This organization</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            Org admins publish cases and change memberships for their own org. They do not see
            other teachers&apos; drafts.
          </p>
        </Panel>
        <Panel
          title={
            <span className="inline-flex items-center gap-2">
              <BadgeCheck className="h-4 w-4 text-accent" aria-hidden="true" />
              Platform admin
            </span>
          }
        >
          <p className="text-sm font-semibold text-primary">Every teacher</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            Platform staff sign in with a normal account after an operator grants
            super_admin. The first grant is <span className="font-medium text-secondary">npm run admin:grant -- email</span>.
            There is no public admin sign-up.
          </p>
        </Panel>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {TILES.map((tile) => (
          <div
            key={tile.title}
            className="flex flex-col gap-2 rounded-xl border border-dashed border-strong bg-surface/60 p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-elevated text-muted">
                {tile.icon}
              </span>
              <Badge variant="neutral">{tile.badge}</Badge>
            </div>
            <p className="text-sm font-semibold text-primary">{tile.title}</p>
            <p className="text-xs leading-relaxed text-muted">{tile.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

const TILES = [
  {
    icon: <BadgeCheck className="h-5 w-5" aria-hidden="true" />,
    title: "Author verification",
    description: "Review credentials on the Teachers tab before public publish.",
    badge: "Live",
  },
  {
    icon: <ScanSearch className="h-5 w-5" aria-hidden="true" />,
    title: "De-identification",
    description: "Header gate on upload; publish blocked without a passing report.",
    badge: "Live",
  },
  {
    icon: <Wallet className="h-5 w-5" aria-hidden="true" />,
    title: "Payouts",
    description: "Marketplace earnings via the payments seam (India PSP later).",
    badge: "Coming in P3",
  },
];
