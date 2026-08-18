"use client";

import { useState } from "react";
import Link from "next/link";
import { BadgeCheck, Building2, CircleAlert, ShieldQuestion, Users } from "lucide-react";
import { Badge, Button, EmptyState, Modal, Skeleton } from "@/components/ui";
import type { Author } from "./types";

/**
 * Teacher verification queue — lists org authors with a placeholder review
 * action. Real credential review lands with AuthorProfile.verification (P0).
 */
export function TeachersQueue({
  authors,
  loading,
  error,
  onRetry,
}: {
  authors: Author[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [reviewing, setReviewing] = useState<Author | null>(null);

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
          {authors.map((author) => (
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
                <Badge variant="warning" className="gap-1">
                  <ShieldQuestion className="h-3 w-3" aria-hidden="true" />
                  Unverified
                </Badge>
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
          ))}
        </ul>
      </div>

      <Modal
        open={reviewing != null}
        onClose={() => setReviewing(null)}
        title="Verification queue"
        description={
          reviewing
            ? `Credential review for ${reviewing.name} is not open yet. Unverified teachers cannot publish to the public marketplace once this gate ships.`
            : undefined
        }
        footer={
          <Button variant="secondary" onClick={() => setReviewing(null)}>
            Close
          </Button>
        }
      />
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
