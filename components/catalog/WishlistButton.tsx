"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, Heart } from "lucide-react";
import { IconButton, useToast } from "@/components/ui";

export function WishlistButton({
  courseId,
  initiallyWishlisted = false,
  variant = "heart",
}: {
  courseId: string;
  initiallyWishlisted?: boolean;
  /** `heart` for course hero; `bookmark` for compact rows. */
  variant?: "heart" | "bookmark";
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [saved, setSaved] = useState(initiallyWishlisted);
  const [loading, setLoading] = useState(false);

  const Icon = variant === "heart" ? Heart : Bookmark;
  const label = saved ? "Remove from wishlist" : "Save to wishlist";

  async function toggle() {
    setLoading(true);
    try {
      if (saved) {
        const res = await fetch(`/api/wishlist?courseId=${encodeURIComponent(courseId)}`, {
          method: "DELETE",
        });
        if (res.status === 401) {
          router.push(`/sign-in?next=/course/${encodeURIComponent(courseId)}`);
          return;
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        setSaved(false);
        toast({ title: "Removed from wishlist", variant: "success" });
      } else {
        const res = await fetch("/api/wishlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ courseId }),
        });
        if (res.status === 401) {
          router.push(`/sign-in?next=/course/${encodeURIComponent(courseId)}`);
          return;
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        setSaved(true);
        toast({ title: "Saved to wishlist", variant: "success" });
      }
    } catch (e) {
      toast({
        title: "Could not update wishlist",
        description: (e as Error).message,
        variant: "danger",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <IconButton
      aria-label={label}
      title={label}
      onClick={toggle}
      loading={loading}
      variant="ghost"
      className={saved ? "text-accent" : "text-secondary hover:text-accent"}
    >
      <Icon
        className="h-4 w-4"
        aria-hidden="true"
        fill={saved && variant === "heart" ? "currentColor" : "none"}
      />
    </IconButton>
  );
}
