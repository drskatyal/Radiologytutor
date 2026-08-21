// Client-side types + fetch wrappers for the catalog (the public library).
// The client talks only to /api/catalog — it never imports lib/cases (§3).

import type { Author, Case, Course, Playlist, BodySystem, Difficulty } from "@/lib/types";

export type { Author, Case, Course, Playlist, BodySystem, Difficulty };

export interface CatalogFacets {
  systems: BodySystem[];
  difficulties: Difficulty[];
  modalities: string[];
  specialties: string[];
}

export interface CatalogResponse {
  cases: Case[];
  facets: CatalogFacets;
  authors: Author[];
  courses: Course[];
  playlists: Playlist[];
}

export interface CatalogQuery {
  system?: string;
  difficulty?: string;
  modality?: string;
  specialty?: string;
  author?: string;
  q?: string;
  sort?: string;
}

/** Build a URLSearchParams from a catalog query, dropping empty values. */
export function catalogParams(q: CatalogQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v) params.set(k, v);
  }
  return params;
}

export async function fetchCatalog(q: CatalogQuery): Promise<CatalogResponse> {
  const params = catalogParams(q);
  const res = await fetch(`/api/catalog?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.json();
}
