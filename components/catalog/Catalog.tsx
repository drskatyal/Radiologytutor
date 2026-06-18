"use client";

// The filterable case library (CLAUDE.md §2). Filters live in the URL
// (?system=&difficulty=&modality=&specialty=&author=&q=&sort=) so a filtered
// view is shareable and survives reload/back-forward. The component owns:
//   - reading the active filter from the URL (single source of truth),
//   - debounced search,
//   - fetching /api/catalog on every filter change (loading/empty/error states),
//   - rendering the Courses/Continue rails + the filtered, animated grid.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { CircleAlert, Filter, Search, SlidersHorizontal, X } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  Skeleton,
} from "@/components/ui";
import { DIFFICULTIES, BODY_SYSTEMS } from "@/lib/types";
import { difficultyLabel } from "@/lib/taxonomy";
import { CaseCardGrid } from "./CaseCard";
import { CoursesRail, PlaylistsRail } from "./Rails";
import {
  fetchCatalog,
  type Author,
  type CatalogQuery,
  type CatalogResponse,
} from "./types";

/** The filter keys we persist in the URL. */
const FILTER_KEYS = ["system", "difficulty", "modality", "specialty", "author", "q", "sort"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

const SORTS: { value: string; label: string }[] = [
  { value: "recent", label: "Most recent" },
  { value: "title", label: "Title (A–Z)" },
  { value: "difficulty", label: "Difficulty" },
];

function readQuery(params: URLSearchParams): CatalogQuery {
  const q: CatalogQuery = {};
  for (const k of FILTER_KEYS) {
    const v = params.get(k);
    if (v) q[k] = v;
  }
  return q;
}

export function Catalog({ initial }: { initial: CatalogResponse }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // The active filter, derived from the URL (single source of truth).
  const query = useMemo(() => readQuery(new URLSearchParams(searchParams.toString())), [searchParams]);

  const [data, setData] = useState<CatalogResponse>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local, immediately-responsive search box mirrored into the URL (debounced).
  const [searchText, setSearchText] = useState(query.q ?? "");

  const authorById = useMemo<Record<string, Author>>(
    () => Object.fromEntries(data.authors.map((a) => [a.id, a])),
    [data.authors]
  );

  // Keep the search box in sync if the URL changes externally (e.g. back button).
  useEffect(() => {
    setSearchText(query.q ?? "");
  }, [query.q]);

  // Fetch whenever the URL-derived query changes. Skip the very first render —
  // we already have server-rendered `initial` for the unfiltered view.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      // Only skip when the initial URL has no filters (matches `initial`).
      if (FILTER_KEYS.every((k) => !query[k])) return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    fetchCatalog(query)
      .then((res) => {
        if (active) setData(res);
      })
      .catch((e) => active && setError((e as Error).message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  /** Write a single filter into the URL (replace, no history spam). */
  const setFilter = useCallback(
    (key: FilterKey, value: string | undefined) => {
      const next = new URLSearchParams(searchParams.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  // Debounce the search box into the URL.
  useEffect(() => {
    const handle = setTimeout(() => {
      if ((query.q ?? "") !== searchText) {
        setFilter("q", searchText.trim() || undefined);
      }
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  const clearAll = useCallback(() => {
    setSearchText("");
    router.replace(pathname, { scroll: false });
  }, [router, pathname]);

  const activeCount = FILTER_KEYS.filter((k) => k !== "sort" && query[k]).length;
  const { facets } = data;

  // Rails only show in the unfiltered view (a clean library landing).
  const showRails = activeCount === 0 && !query.q;

  return (
    <div className="flex flex-col gap-8">
      {showRails && (
        <>
          <CoursesRail courses={data.courses} authorById={authorById} />
          <PlaylistsRail playlists={data.playlists} />
        </>
      )}

      {/* Filter bar */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
            />
            <Input
              type="search"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search cases, tags, specialties…"
              aria-label="Search cases"
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-muted" aria-hidden="true" />
            <Select
              value={query.sort ?? "recent"}
              onChange={(e) => setFilter("sort", e.target.value === "recent" ? undefined : e.target.value)}
              aria-label="Sort cases"
              className="h-10 w-44"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
            <Filter className="h-3.5 w-3.5" aria-hidden="true" />
            Filter
          </span>
          <FilterSelect
            label="System"
            value={query.system}
            onChange={(v) => setFilter("system", v)}
            options={BODY_SYSTEMS as readonly string[]}
          />
          <FilterSelect
            label="Difficulty"
            value={query.difficulty}
            onChange={(v) => setFilter("difficulty", v)}
            options={DIFFICULTIES as readonly string[]}
            renderLabel={(v) => difficultyLabel(v as (typeof DIFFICULTIES)[number])}
          />
          <FilterSelect
            label="Modality"
            value={query.modality}
            onChange={(v) => setFilter("modality", v)}
            options={facets.modalities}
          />
          <FilterSelect
            label="Specialty"
            value={query.specialty}
            onChange={(v) => setFilter("specialty", v)}
            options={facets.specialties}
          />
          <FilterSelect
            label="Author"
            value={query.author}
            onChange={(v) => setFilter("author", v)}
            options={data.authors.map((a) => a.id)}
            renderLabel={(id) => authorById[id]?.name ?? id}
          />
          {activeCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearAll}
              leadingIcon={<X className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Result count */}
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold tracking-tight text-primary">
          {activeCount > 0 || query.q ? "Results" : "All cases"}
        </h2>
        <span className="inline-flex items-center gap-2 text-sm tabular-nums text-muted">
          {loading && <Skeleton className="h-3 w-10" />}
          {!loading && (
            <Badge variant="neutral" className="tabular-nums">
              {data.cases.length} case{data.cases.length === 1 ? "" : "s"}
            </Badge>
          )}
        </span>
      </div>

      {/* Grid / states */}
      <AnimatePresence mode="wait" initial={false}>
        {loading ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <CatalogSkeleton />
          </motion.div>
        ) : error ? (
          <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <EmptyState
              icon={<CircleAlert aria-hidden="true" />}
              title="Couldn't load the library"
              description={error}
              action={
                <Button variant="secondary" onClick={() => fetchCatalog(query).then(setData).catch(() => {})}>
                  Retry
                </Button>
              }
            />
          </motion.div>
        ) : data.cases.length === 0 ? (
          <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <EmptyState
              icon={<Search aria-hidden="true" />}
              title="No cases match these filters"
              description="Try widening your search or clearing a filter."
              action={
                activeCount > 0 || query.q ? (
                  <Button variant="secondary" onClick={clearAll}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </motion.div>
        ) : (
          <motion.div key="grid" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <CaseCardGrid cases={data.cases} authorById={authorById} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A labelled filter dropdown with an "All" option. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
  renderLabel,
}: {
  label: string;
  value?: string;
  onChange: (value: string | undefined) => void;
  options: readonly string[];
  renderLabel?: (value: string) => string;
}) {
  const active = !!value;
  return (
    <Select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || undefined)}
      aria-label={`Filter by ${label.toLowerCase()}`}
      className={active ? "h-9 w-auto min-w-[8rem] border-accent/50 text-primary" : "h-9 w-auto min-w-[8rem] text-secondary"}
    >
      <option value="">{label}: All</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {renderLabel ? renderLabel(o) : o}
        </option>
      ))}
    </Select>
  );
}

function CatalogSkeleton() {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="rounded-xl border border-subtle bg-elevated p-5">
          <Skeleton className="h-5 w-3/4" />
          <div className="mt-3 flex gap-2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-14" />
          </div>
          <Skeleton className="mt-4 h-3 w-1/2" />
        </li>
      ))}
    </ul>
  );
}
