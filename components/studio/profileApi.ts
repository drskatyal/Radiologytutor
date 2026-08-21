// Thin client for the Studio "my author profile" seam (/api/studio/profile).

import type { Author, BodySystem } from "@/lib/types";

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

export async function fetchProfile(): Promise<Author> {
  const res = await fetch("/api/studio/profile", { cache: "no-store" });
  return (await json<{ author: Author }>(res)).author;
}

export interface ProfilePatch {
  name?: string;
  bio?: string;
  institution?: string;
  avatarUrl?: string;
  credentials?: string;
  subspecialties?: BodySystem[];
  socials?: { website?: string; twitter?: string; linkedin?: string };
}

export async function updateProfile(patch: ProfilePatch): Promise<Author> {
  const res = await fetch("/api/studio/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return (await json<{ author: Author }>(res)).author;
}
