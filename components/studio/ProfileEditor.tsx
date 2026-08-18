"use client";

// Studio / Profile — the author's public teaching face. Single-author seam:
// resolves "me" via /api/studio/profile (getPrimaryAuthor), the documented
// placeholder for the session user until Clerk + AuthorProfile land
// (CLAUDE.md §6). Shows a live preview of how the author appears on a case,
// plus a "verification" placeholder badge (ARCHITECTURE §9 trust signals).

import { useEffect, useState } from "react";
import Link from "next/link";
import { Building2, CircleAlert, ExternalLink, ShieldAlert } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageContainer,
  Skeleton,
  Textarea,
  useToast,
} from "@/components/ui";
import { StudioHeader } from "./StudioHeader";
import { VoiceEnrollment } from "./VoiceEnrollment";
import { fetchProfile, updateProfile } from "./profileApi";
import { BODY_SYSTEMS, type Author, type BodySystem } from "@/lib/types";
import { cn } from "@/components/ui/cn";

export function ProfileEditor() {
  const { toast } = useToast();
  const [author, setAuthor] = useState<Author | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [credentials, setCredentials] = useState("");
  const [institution, setInstitution] = useState("");
  const [subspecialties, setSubspecialties] = useState<BodySystem[]>([]);
  const [bio, setBio] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");

  function load() {
    setLoading(true);
    fetchProfile()
      .then((a) => {
        setAuthor(a);
        setName(a.name ?? "");
        setCredentials(a.credentials ?? "");
        setInstitution(a.institution ?? "");
        setSubspecialties(a.subspecialties ?? []);
        setBio(a.bio ?? "");
        setAvatarUrl(a.avatarUrl ?? "");
        setError(null);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  function toggleSubspecialty(s: BodySystem) {
    setSubspecialties((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  async function save() {
    if (!name.trim()) {
      toast({ variant: "danger", title: "Name is required" });
      return;
    }
    setSaving(true);
    try {
      const updated = await updateProfile({
        name: name.trim(),
        credentials: credentials.trim() || undefined,
        institution: institution.trim() || undefined,
        subspecialties,
        bio: bio.trim() || undefined,
        avatarUrl: avatarUrl.trim() || undefined,
      });
      setAuthor(updated);
      toast({ variant: "success", title: "Profile saved" });
    } catch (e) {
      toast({ variant: "danger", title: "Couldn't save profile", description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const isUnset = !!author && !author.credentials && !author.institution && !author.bio;

  return (
    <div className="animate-fade-in">
      <StudioHeader active="profile" />
      <PageContainer width="narrow">
        {loading ? (
          <ProfileSkeleton />
        ) : error ? (
          <Card className="flex flex-col items-center gap-3 py-10 text-center">
            <CircleAlert className="h-6 w-6 text-danger" aria-hidden="true" />
            <p className="text-sm font-medium text-primary">Couldn&apos;t load your profile</p>
            <p className="text-sm text-muted">{error}</p>
            <Button variant="secondary" onClick={load}>
              Retry
            </Button>
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="flex flex-col gap-6">
              {isUnset && (
                <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                  <div>
                    <p className="font-medium text-primary">Finish your author profile</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">
                      Add your credentials and subspecialty so learners trust your teaching.
                    </p>
                  </div>
                </div>
              )}

              <Section title="Identity" caption="How you're named and credited across the library.">
                <Field label="Display name" required>
                  {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Credentials" hint="e.g. MD, FRCR">
                    {(p) => <Input {...p} value={credentials} onChange={(e) => setCredentials(e.target.value)} />}
                  </Field>
                  <Field label="Institution">
                    {(p) => <Input {...p} value={institution} onChange={(e) => setInstitution(e.target.value)} />}
                  </Field>
                </div>
              </Section>

              <Section title="Expertise" caption="Subspecialties shown as tags on your profile.">
                <div className="flex flex-wrap gap-2">
                  {BODY_SYSTEMS.map((s) => {
                    const active = subspecialties.includes(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleSubspecialty(s)}
                        className={cn(
                          "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                          active
                            ? "border-accent/40 bg-accent/10 text-accent"
                            : "border-strong bg-elevated text-secondary hover:text-primary"
                        )}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              </Section>

              <Section title="About" caption="A short teaching bio shown on your public profile.">
                <Field label="Bio">
                  {(p) => <Textarea {...p} rows={5} value={bio} onChange={(e) => setBio(e.target.value)} maxLength={1000} />}
                </Field>
              </Section>

              <Section title="Avatar" caption="Falls back to your initials when unset.">
                <Field label="Avatar URL" hint="Direct image link. Upload support is coming later.">
                  {(p) => <Input {...p} value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://…" />}
                </Field>
              </Section>

              <VoiceEnrollment authorName={name || author?.name || "Teacher"} />

              <div className="flex items-center justify-between">
                {author && (
                  <Link
                    href={`/authors/${encodeURIComponent(author.id)}`}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-secondary transition-colors hover:text-accent"
                  >
                    View public profile
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                )}
                <Button onClick={save} loading={saving}>
                  Save profile
                </Button>
              </div>
            </div>

            {/* Live preview */}
            <div className="lg:sticky lg:top-6 lg:self-start">
              <Card>
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
                  How you appear on a case
                </p>
                <div className="flex items-start gap-3">
                  <Avatar name={name || "?"} url={avatarUrl} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-primary">{name || "Your name"}</p>
                    {credentials && <p className="truncate text-xs text-muted">{credentials}</p>}
                  </div>
                </div>
                {institution && (
                  <p className="mt-3 flex items-center gap-1.5 text-xs text-secondary">
                    <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {institution}
                  </p>
                )}
                {subspecialties.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {subspecialties.map((s) => (
                      <Badge key={s} variant="info">
                        {s}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="mt-4 border-t border-subtle pt-3">
                  <Badge variant="neutral">Unverified</Badge>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                    Author verification is coming — credentials will be reviewed before this badge upgrades.
                  </p>
                </div>
              </Card>
            </div>
          </div>
        )}
      </PageContainer>
    </div>
  );
}

function Avatar({ name, url }: { name: string; url?: string }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover ring-1 ring-inset ring-subtle" />;
  }
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-elevated text-sm font-semibold text-secondary ring-1 ring-inset ring-subtle">
      {initials}
    </span>
  );
}

function Section({ title, caption, children }: { title: string; caption: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-primary">{title}</h3>
        <p className="text-xs text-muted">{caption}</p>
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function ProfileSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
