"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Skeleton,
  Textarea,
  useToast,
} from "@/components/ui";
import type { Review } from "@/lib/types";

interface ReviewsData {
  reviews: Review[];
  average: number;
  count: number;
}

function StarRating({
  value,
  onChange,
  readonly = false,
}: {
  value: number;
  onChange?: (rating: number) => void;
  readonly?: boolean;
}) {
  return (
    <div className="flex items-center gap-0.5" role={readonly ? "img" : "radiogroup"} aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          disabled={readonly}
          onClick={() => onChange?.(star)}
          className={`rounded p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default ${
            star <= value ? "text-warning" : "text-muted hover:text-warning/70"
          }`}
          aria-label={`${star} star${star === 1 ? "" : "s"}`}
        >
          <Star
            className="h-4 w-4"
            aria-hidden="true"
            fill={star <= value ? "currentColor" : "none"}
          />
        </button>
      ))}
    </div>
  );
}

function ReviewRow({ review }: { review: Review }) {
  const date = new Date(review.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return (
    <li className="rounded-xl border border-subtle bg-elevated p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-primary">
          {review.authorName ?? "Learner"}
        </span>
        <div className="flex items-center gap-2">
          <StarRating value={review.rating} readonly />
          <span className="text-xs tabular-nums text-muted">{date}</span>
        </div>
      </div>
      {review.body && (
        <p className="mt-2 text-sm leading-relaxed text-secondary">{review.body}</p>
      )}
    </li>
  );
}

export function CourseReviews({
  courseId,
  initial,
  isSignedIn,
}: {
  courseId: string;
  initial?: ReviewsData;
  isSignedIn: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [data, setData] = useState<ReviewsData | null>(initial ?? null);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/reviews?courseId=${encodeURIComponent(courseId)}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error || `Request failed (${res.status})`);
        }
        const summary = (await res.json()) as ReviewsData;
        if (!cancelled) setData(summary);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [courseId, initial]);

  async function submitReview(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, rating, body: body.trim() || undefined }),
      });
      if (res.status === 401) {
        router.push(`/sign-in?next=/course/${encodeURIComponent(courseId)}`);
        return;
      }
      const payload = (await res.json().catch(() => ({}))) as ReviewsData & { error?: string };
      if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);
      setData({
        reviews: payload.reviews,
        average: payload.average,
        count: payload.count,
      });
      setBody("");
      toast({ title: "Review submitted", variant: "success" });
      router.refresh();
    } catch (e) {
      toast({
        title: "Could not submit review",
        description: (e as Error).message,
        variant: "danger",
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={<Star aria-hidden="true" />}
        title="Couldn't load reviews"
        description={error}
      />
    );
  }

  const summary = data ?? { reviews: [], average: 0, count: 0 };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Star className="h-5 w-5 text-warning" fill="currentColor" aria-hidden="true" />
          <span className="font-display text-2xl font-semibold tabular-nums text-primary">
            {summary.count > 0 ? summary.average.toFixed(1) : "—"}
          </span>
        </div>
        <Badge variant="neutral" className="tabular-nums">
          {summary.count} review{summary.count === 1 ? "" : "s"}
        </Badge>
      </div>

      {isSignedIn && (
        <form
          onSubmit={submitReview}
          className="rounded-xl border border-subtle bg-surface p-4"
        >
          <h3 className="font-display text-sm font-semibold text-primary">Write a review</h3>
          <div className="mt-3">
            <Field label="Rating">
              {() => <StarRating value={rating} onChange={setRating} />}
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Comments (optional)">
              {(props) => (
                <Textarea
                  {...props}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={3}
                  placeholder="What did you learn from this course?"
                />
              )}
            </Field>
          </div>
          <div className="mt-4">
            <Button type="submit" loading={submitting}>
              Submit review
            </Button>
          </div>
        </form>
      )}

      {summary.reviews.length === 0 ? (
        <EmptyState
          icon={<Star aria-hidden="true" />}
          title="No reviews yet"
          description={
            isSignedIn
              ? "Be the first to share your experience."
              : "Sign in to leave the first review."
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {summary.reviews.map((review) => (
            <ReviewRow key={review.id} review={review} />
          ))}
        </ul>
      )}
    </div>
  );
}
