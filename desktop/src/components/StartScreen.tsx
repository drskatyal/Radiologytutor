// First thing the user sees: open something, re-open something recent, or
// pick the disc that just went into the drive. Paints without Cornerstone.

import { useEffect, useState } from "react";
import { Clock, Disc3, FileArchive, Files, FolderOpen, FolderTree, HardDrive, ShieldCheck, Usb, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import { cn } from "@/components/ui/cn";
import { listMedia, type MediaVolume } from "../platform";
import type { HistoryEntry } from "../history";
import { formatDicomDate } from "../study";
import { isMac } from "../shortcuts";

interface Props {
  history: HistoryEntry[];
  onOpen: (what: "files" | "folder" | "zip" | "dicomdir" | "disc") => void;
  onOpenPaths: (paths: string[], kind?: "disc") => void;
  onForget: (key: string) => void;
  onClearHistory: () => void;
  version: string;
  dragging: boolean;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.round((Date.now() - then) / 60000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}

const KIND_ICON = {
  folder: FolderTree,
  dicomdir: FolderTree,
  zip: FileArchive,
  files: Files,
  disc: Disc3,
} as const;

export function StartScreen({ history, onOpen, onOpenPaths, onForget, onClearHistory, version, dragging }: Props) {
  const [media, setMedia] = useState<MediaVolume[] | null>(null);
  const m = isMac() ? "⌘" : "Ctrl+";

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      listMedia()
        .then((v) => alive && setMedia(v))
        .catch(() => alive && setMedia([]));
    refresh();
    // A disc inserted while the start screen is up should simply appear.
    const timer = window.setInterval(refresh, 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className={cn("flex h-full overflow-y-auto transition-colors", dragging && "bg-accent-muted/20")}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-8 py-10">
        <header className="flex items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent-bright">
              <span className="inline-block h-2 w-2 rounded-full bg-accent-bright" aria-hidden />
              RadLearn Viewer
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-primary">Open a study</h1>
            <p className="mt-1 max-w-xl text-sm text-secondary">
              Folders, DICOMDIR, zip archives and CD / DVD media. Everything is read on this computer — no account, no
              upload, no network.
            </p>
          </div>
          <div className="hidden shrink-0 items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-3 py-1 text-xs text-success md:flex">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            Offline
          </div>
        </header>

        <section aria-label="Open" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { what: "folder" as const, label: "Folder", hint: `${m}⇧O`, icon: FolderOpen, primary: true },
            { what: "files" as const, label: "Files", hint: `${m}O`, icon: Files },
            { what: "zip" as const, label: "Zip archive", hint: `${m}⇧Z`, icon: FileArchive },
            { what: "dicomdir" as const, label: "DICOMDIR", hint: "", icon: FolderTree },
          ].map((item) => (
            <button
              key={item.what}
              type="button"
              onClick={() => onOpen(item.what)}
              className={cn(
                "group flex flex-col items-start gap-3 rounded-xl border p-4 text-left transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                item.primary
                  ? "border-accent/60 bg-accent-muted/40 hover:bg-accent-muted/60"
                  : "border-subtle bg-surface hover:border-strong hover:bg-elevated"
              )}
            >
              <item.icon className={cn("h-5 w-5", item.primary ? "text-accent-bright" : "text-secondary group-hover:text-primary")} aria-hidden />
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-semibold text-primary">{item.label}</span>
                {item.hint && <Kbd>{item.hint}</Kbd>}
              </span>
            </button>
          ))}
        </section>

        <section aria-label="Discs and removable media" className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Discs &amp; USB</h2>
            <Button size="sm" variant="ghost" onClick={() => onOpen("disc")} leadingIcon={<Disc3 className="h-4 w-4" />}>
              Choose a drive… <Kbd className="ml-1">{m}⌥O</Kbd>
            </Button>
          </div>
          {media === null ? (
            <div className="h-14 animate-pulse rounded-xl border border-subtle bg-surface" />
          ) : media.length === 0 ? (
            <p className="rounded-xl border border-dashed border-subtle px-4 py-4 text-sm text-muted">
              No CD, DVD or USB drive detected. Insert one and it will appear here.
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {media.map((v) => {
                const Icon = v.kind === "optical" ? Disc3 : Usb;
                return (
                  <li key={v.path}>
                    <button
                      type="button"
                      onClick={() => onOpenPaths([v.path], "disc")}
                      className="flex w-full items-center gap-3 rounded-xl border border-subtle bg-surface px-4 py-3 text-left hover:border-strong hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <Icon className="h-5 w-5 text-secondary" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-primary">{v.label}</span>
                        <span className="block truncate text-xs text-muted">{v.path}</span>
                      </span>
                      {v.hasDicomdir && (
                        <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">DICOMDIR</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="Recent studies" className="flex min-h-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Recent</h2>
            {history.length > 0 && (
              <Button size="sm" variant="ghost" onClick={onClearHistory}>
                Forget all
              </Button>
            )}
          </div>
          {history.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-subtle px-6 py-10 text-center">
              <HardDrive className="h-6 w-6 text-muted" aria-hidden />
              <p className="text-sm text-secondary">Studies you open appear here for one-click re-opening.</p>
              <p className="text-xs text-muted">Or drop a folder, zip or DICOM files anywhere on this window.</p>
            </div>
          ) : (
            <ul className="divide-y divide-subtle overflow-hidden rounded-xl border border-subtle bg-surface">
              {history.map((entry) => {
                const Icon = KIND_ICON[entry.kind] ?? FolderTree;
                return (
                  <li key={entry.key} className="group flex items-center gap-3 px-4 py-2.5 hover:bg-elevated">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      onClick={() => onOpenPaths(entry.paths)}
                      title={entry.paths.join("\n")}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-primary">
                          {entry.description || entry.label}
                        </span>
                        <span className="block truncate text-xs text-muted tabular-nums">
                          {[entry.modalities.join(" / "), formatDicomDate(entry.studyDate), `${entry.seriesCount} series`, `${entry.imageCount.toLocaleString()} images`, entry.label]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
                        <Clock className="h-3 w-3" aria-hidden />
                        {relativeTime(entry.openedAt)}
                      </span>
                    </button>
                    <IconButton
                      aria-label={`Forget ${entry.label}`}
                      size="sm"
                      variant="danger"
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => onForget(entry.key)}
                    >
                      <X />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-muted">
            History keeps folder paths and study descriptions only — never patient names or images.
          </p>
        </section>

        <footer className="mt-auto flex items-center justify-between border-t border-subtle pt-4 text-xs text-muted">
          <span>Not for diagnostic use.</span>
          <span className="tabular-nums">v{version}</span>
        </footer>
      </div>
    </div>
  );
}
