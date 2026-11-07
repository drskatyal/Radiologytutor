"use client";

// The Watched folders dialog (Chrome / Edge), loaded on first open so the
// free viewer's first paint does not carry it (WebWatchFolders.tsx).

import { useSyncExternalStore } from "react";
import { FolderSync, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/components/ui/cn";
import type { WatchStatus } from "@flowrad/viewer-core/folderWatch";
import type { WebFolderView, WebFolderWatcher } from "@/lib/webFolderWatch";

const EMPTY: WebFolderView[] = [];

function statusText(s: WatchStatus): string {
  switch (s.state) {
    case "watching":
      return s.waiting ? `Watching · ${s.waiting.toLocaleString()} file${s.waiting === 1 ? "" : "s"} still arriving or queued` : "Watching while this tab is open";
    case "error":
      return `${s.message} Retrying in ${Math.round(s.retryInMs / 1000)} s.`;
    case "permission":
      return s.message;
    case "stopped":
      return "Stopped";
    default:
      return "Starting…";
  }
}

export function WebWatchFoldersDialog({
  open,
  onClose,
  watcher,
  onOpenFiles,
  tone,
}: {
  open: boolean;
  onClose: () => void;
  watcher: WebFolderWatcher;
  onOpenFiles: (files: File[]) => void;
  /** `reading`: the reading room's dark dialog; `viewer`: the free viewer landing's. */
  tone?: "app" | "reading" | "viewer";
}) {
  const folders = useSyncExternalStore(
    (fn) => watcher.subscribe(fn),
    () => watcher.snapshot(),
    () => EMPTY
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Watched folders"
      description="New DICOM studies copied into these folders appear here while this tab is open. Folders are only read; nothing is uploaded."
      size="xl"
      tone={tone}
      footer={
        <Button size="sm" variant="primary" onClick={() => void watcher.add()} leadingIcon={<FolderSync className="h-4 w-4" aria-hidden />}>
          Watch a folder…
        </Button>
      }
    >
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto text-sm">
        {folders.length === 0 && (
          <p className="text-secondary">
            No folder is watched. The browser asks for permission to read the folder you choose, and again after the page is reloaded. Files are
            read only once they have stopped changing.
          </p>
        )}
        {folders.map((f) => (
          <section key={f.id} className="rounded-lg border border-subtle bg-surface p-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium text-primary">{f.name}</span>
              {f.status.state === "permission" ? (
                <Button size="sm" variant="secondary" onClick={() => void watcher.reconnect(f.id)}>
                  Allow again
                </Button>
              ) : (
                <>
                  <IconButton aria-label={f.enabled ? "Stop watching this folder" : "Start watching this folder"} size="sm" onClick={() => void watcher.setEnabled(f.id, !f.enabled)}>
                    {f.enabled ? <Pause /> : <Play />}
                  </IconButton>
                  <IconButton aria-label="Check this folder now" size="sm" disabled={!f.enabled} onClick={() => void watcher.pollNow(f.id)}>
                    <RefreshCw />
                  </IconButton>
                </>
              )}
              <IconButton aria-label="Remove this folder from the list (the folder itself is not touched)" size="sm" variant="danger" onClick={() => void watcher.remove(f.id)}>
                <Trash2 />
              </IconButton>
            </div>
            <p className={cn("mt-1 text-xs", f.status.state === "error" ? "text-danger" : "text-secondary")} role={f.status.state === "error" ? "alert" : undefined}>
              {statusText(f.status)}
              {f.skipped > 0 && ` · ${f.skipped.toLocaleString()} non-DICOM or unreadable file${f.skipped === 1 ? "" : "s"} skipped`}
            </p>
            {f.studies.length > 0 && (
              <ul className="mt-2 divide-y divide-subtle rounded-md border border-subtle">
                {f.studies.map((s) => (
                  <li key={s.key} className="flex items-center gap-3 px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-primary">{s.description || `${s.modalities.join("/") || "DICOM"} study`}</div>
                      <div className="text-xs tabular-nums text-secondary">
                        {[s.date, s.modalities.join(" · "), `${s.seriesCount} series`, `${s.imageCount.toLocaleString()} images`].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        void watcher.filesOf(f.id, s.key).then((files) => {
                          if (!files.length) return;
                          onClose();
                          onOpenFiles(files);
                        })
                      }
                    >
                      Open
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
        <p className="text-xs text-muted">
          Only standard DICOM files are read; proprietary or encrypted formats are skipped. Watching stops when this tab closes and pauses while it is
          hidden.
        </p>
      </div>
    </Modal>
  );
}
