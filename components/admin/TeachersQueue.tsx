"use client";

import { useState } from "react";
import Link from "next/link";
import {
  BadgeCheck,
  Building2,
  CircleAlert,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Users,
} from "lucide-react";
import { Badge, Button, EmptyState, Modal, Skeleton, useToast } from "@/components/ui";
import { updateAuthor as apiUpdateAuthor } from "./api";
import type { Author } from "./types";

type VerificationStatus = NonNullable<Author["verification"]> | "unverified";

function resolveVerification(author: Author): VerificationStatus {
  return author.verification ?? "unverified";
}

function VerificationBadge({ status }: { status: VerificationStatus }) {
  switch (status) {
    case "verified":
      return (
        <Badge variant="success" className="gap-1">
          <ShieldCheck className="h-3 w-3" aria-hidden="true" />
          Verified
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="warning" className="gap-1">
          <ShieldQuestion className="h-3 w-3" aria-hidden="true" />
          Pending
        </Badge>
      );
    case "rejected":
      return (
        <Badge variant="danger" className="gap-1">
          <ShieldAlert className="h-3 w-3" aria-hidden="true" />
          Rejected
        </Badge>
      );
    default:
      return (
        <Badge variant="warning" className="gap-1">
          <ShieldQuestion className="h-3 w-3" aria-hidden="true" />
          Unverified
        </Badge>
      );
  }
}

export function TeachersQueue({
  authors,
  loading,
  error,
  onRetry,
  onUpdated,
}: {
  authors: Author[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onUpdated?: (author: Author) => void;
}) {
  const { toast } = useToast();
  const [reviewing, setReviewing] = useState<Author | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submitVerification(
    author: Author,
    verification: "verified" | "rejected"
  ) {
    setSubmitting(true);
    try {
      const updated = await apiUpdateAuthor(author.id, { verification });
      onUpdated?.(updated);
      setReviewing(null);
      toast({
        title: verification === "verified" ? "Teacher verified" : "Verification rejected",
        description:
          verification === "verified"
            ? `${author.name} can publish to the public marketplace.`
            : `${author.name} was marked as rejected.`,
        variant: verification === "verified" ? "success" : "warning",
      });
    } catch (e) {
      toast({
        title: "Could not update verification",
        description: (e as Error).message,
        variant: "danger",
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <TeachersSkeleton />;

  if (error) {
    return (
      <EmptyState
        icon={<CircleAlert aria-hidden="true" />}
        title="Couldn't load teachers"
        description={error}
        action={
          <Button variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        }
      />
    );
  }

  if (authors.length === 0) {
    return (
      <EmptyState
        icon={<Users aria-hidden="true" />}
        title="No teachers yet"
        description="Author profiles created in Studio will appear here for verification."
      />
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-subtle bg-elevated shadow-sm">
        <div className="hidden grid-cols-[minmax(0,1fr)_10rem_8rem_auto] items-center gap-4 border-b border-subtle px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted lg:grid">
          <span>Teacher</span>
          <span>Institution</span>
          <span>Verification</span>
          <span className="text-right">Actions</span>
        </div>
        <ul className="divide-y divide-subtle">
          {authors.map((author) => {
            const verification = resolveVerification(author);
            return (
              <li
                key={author.id}
                className="flex flex-col gap-3 px-4 py-3.5 transition-colors hover:bg-surface/40 lg:grid lg:grid-cols-[minmax(0,1fr)_10rem_8rem_auto] lg:items-center lg:gap-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-primary">{author.name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {author.credentials || "No credentials on file"}
                  </p>
                </div>
                <div className="hidden min-w-0 text-sm text-secondary lg:block">
                  {author.institution ? (
                    <span className="inline-flex items-center gap-1.5 truncate">
                      <Building2 className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                      {author.institution}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </div>
                <div>
                  <VerificationBadge status={verification} />
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Link href={`/authors/${author.id}`}>
                    <Button size="sm" variant="ghost">
                      Profile
                    </Button>
                  </Link>
                  <Button
                    size="sm"
                    variant="secondary"
                    leadingIcon={<BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />}
                    onClick={() => setReviewing(author)}
                  >
                    Review
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <Modal
        open={reviewing != null}
        onClose={() => !submitting && setReviewing(null)}
        title="Credential review"
        description={
          reviewing
            ? `Review ${reviewing.name}'s credentials before granting marketplace publish access.`
            : undefined
        }
        footer={
          reviewing ? (
            <>
              <Button
                variant="ghost"
                onClick={() => setReviewing(null)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => submitVerification(reviewing, "rejected")}
                loading={submitting}
              >
                Reject
              </Button>
              <Button
                onClick={() => submitVerification(reviewing, "verified")}
                loading={submitting}
                leadingIcon={<BadgeCheck className="h-4 w-4" aria-hidden="true" />}
              >
                Verify
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setReviewing(null)}>
              Close
            </Button>
          )
        }
      >
        {reviewing && (
          <dl className="grid gap-3 text-sm">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted">Credentials</dt>
              <dd className="mt-1 text-primary">
                {reviewing.credentials || "No credentials on file"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted">Institution</dt>
              <dd className="mt-1 text-primary">{reviewing.institution || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted">Status</dt>
              <dd className="mt-1">
                <VerificationBadge status={resolveVerification(reviewing)} />
              </dd>
            </div>
          </dl>
        )}
      </Modal>
    </>
  );
}

function TeachersSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-subtle bg-elevated">
      <ul className="divide-y divide-subtle">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i} className="flex items-center gap-4 px-4 py-4">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-2 h-3 w-24" />
            </div>
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-8 w-20" />
          </li>
        ))}
      </ul>
    </div>
  );
}
