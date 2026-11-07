"use client";
// Recent studies on the free viewer's landing, as the desktop keeps them:
// newest first, one click to reopen (the browser asks to read the folder
// again only when its permission has lapsed), Forget one, or Clear all.
// Shown only where the browser can keep a folder handle (Chromium) and
// something was opened from one. No patient identifiers are shown or kept
// (@flowrad/viewer-core/recentStudies).

import { Clock3, FolderOpen, X } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { openedAgo, recentStudyDetail, recentStudyTitle, type RecentStudy } from "@flowrad/viewer-core/recentStudies";

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
  if (entries.length === 0) return null;
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
      <ul className="divide-y divide-vl-border overflow-hidden rounded-2xl border border-vl-border bg-vl-surface/60">
        {entries.map((e) => {
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
                  {busy ? <Spinner size="sm" label={`Reopening ${title}`} /> : <FolderOpen className="h-4 w-4" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-vl-fg">{title}</span>
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
          Kept only in this browser, as links to the folders: no images and no patient details. Reopening asks to read the folder again if needed.
        </p>
      )}
    </section>
  );
}
