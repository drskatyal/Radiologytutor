"use client";
// Recent studies on the free viewer's landing, as the desktop keeps them:
// newest first, one click to reopen (the browser asks to read the folder
// again only when its permission has lapsed), Forget one, or Clear all, and
// a search over them (description, modality, date) as on the desktop.
// Shown only where the browser can keep a folder handle (Chromium) and
// something was opened from one. No patient identifiers are shown or kept
// (@flowrad/viewer-core/recentStudies).

import { useId, useState } from "react";
import { Clock3, FolderOpen, HardDrive, Search, X } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { openedAgo, recentStudyDetail, recentStudyTitle, searchRecentStudies, type RecentStudy } from "@flowrad/viewer-core/recentStudies";

interface Props {
  entries: readonly RecentStudy[];
  /** The key being reopened (its row shows a spinner; the others wait). */
  opening: string | null;
  /** A short message under the list (a folder that moved, permission refused). */
  notice: string | null;
  onOpen: (key: string) => void;
  onForget: (key: string) => void;
  onClear: () => void;
  now: number;
}

export function RecentStudies({ entries, opening, notice, onOpen, onForget, onClear, now }: Props) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  if (entries.length === 0) return null;
  const shown = searchRecentStudies(entries, query);
  return (
    <section aria-labelledby="recent-studies-title" className="flex flex-col gap-3" data-testid="recent-studies">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="recent-studies-title" className="flex items-center gap-2 text-sm font-semibold text-vl-fg">
          <Clock3 className="h-4 w-4 text-vl-brand" aria-hidden />
          Recent studies
        </h2>
        <button
          type="button"
          onClick={onClear}
          className="rounded-md px-1 text-xs font-medium text-vl-muted underline-offset-4 hover:text-vl-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vl-brand"
        >
          Clear all
        </button>
      </div>
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          Search recent studies
        </label>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-vl-muted" aria-hidden />
        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search description, modality, date…"
          autoComplete="off"
          className="h-9 border-vl-border bg-vl-surface/60 pl-9 text-vl-fg placeholder:text-vl-muted focus:border-vl-brand focus-visible:ring-vl-brand/35"
        />
      </div>
      <ul className="max-h-96 divide-y divide-vl-border overflow-y-auto rounded-2xl border border-vl-border bg-vl-surface/60">
        {shown.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-vl-muted" role="status">
            No recent study matches “{query.trim()}”.
          </li>
        )}
        {shown.map((e) => {
          const title = recentStudyTitle(e);
          const busy = opening === e.key;
          return (
            <li key={e.key} className="flex items-center gap-2 pr-2">
              <button
                type="button"
                onClick={() => onOpen(e.key)}
                disabled={opening != null}
                aria-label={`Reopen ${title}, opened ${openedAgo(e.openedAt, now)}`}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition-colors",
                  "hover:bg-vl-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-vl-brand",
                  "disabled:cursor-wait disabled:hover:bg-transparent"
                )}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-vl-brand-soft text-vl-brand">
                  {busy ? (
                    <Spinner size="sm" label={`Reopening ${title}`} />
                  ) : e.keptBytes ? (
                    <HardDrive className="h-4 w-4" aria-hidden />
                  ) : (
                    <FolderOpen className="h-4 w-4" aria-hidden />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-vl-fg">{title}</span>
                    {e.keptBytes ? (
                      <span data-testid="kept-badge" className="shrink-0 rounded-full bg-vl-brand-soft px-1.5 py-px text-[10px] font-medium text-vl-brand">
                        Kept
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs tabular-nums text-vl-muted">{recentStudyDetail(e)}</span>
                </span>
                <span className="hidden shrink-0 text-xs tabular-nums text-vl-muted sm:block">{openedAgo(e.openedAt, now)}</span>
              </button>
              <IconButton aria-label={`Forget ${title}`} size="sm" variant="ghost" onClick={() => onForget(e.key)} disabled={busy}>
                <X aria-hidden />
              </IconButton>
            </li>
          );
        })}
      </ul>
      {notice ? (
        <p role="status" className="text-xs text-warning">
          {notice}
        </p>
      ) : (
        <p className="text-xs text-vl-muted">
          Kept only in this browser, as links to the folders: no patient details. A study marked Kept also has a copy of its files here, so it reopens without the folder. Reopening asks to read a folder again if needed.
        </p>
      )}
    </section>
  );
}
