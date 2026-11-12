"use client";

// Watched folders on the web: Chrome / Edge only (File System Access API).
// Elsewhere the entry explains that, and offers nothing it cannot do.
//
// Only the support check, the entry button and this hook ship with the
// page. The watcher engine (lib/webFolderWatch, dicom-parser) loads once the
// browser can watch folders, and the dialog on first open.

import { useEffect, useState } from "react";
import { FolderSync } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { idbAll, idbDelete, idbSet } from "@/lib/idbStore";
import type { StoredFolder, WebFolderWatcher } from "@/lib/webFolderWatch";

/** Same rule as lib/webFolderWatch folderWatchSupported (kept here so the check costs no engine download). */
function canWatchFolders(): boolean {
  const win = window as unknown as { showDirectoryPicker?: unknown; FileSystemHandle?: { prototype?: { queryPermission?: unknown } } };
  return typeof win.showDirectoryPicker === "function" && typeof win.FileSystemHandle?.prototype?.queryPermission === "function";
}

export function useWebFolderWatcher(): { supported: boolean; watcher: WebFolderWatcher | null; fresh: number; seen: () => void } {
  const [supported, setSupported] = useState(false);
  const [fresh, setFresh] = useState(0);
  const [watcher, setWatcher] = useState<WebFolderWatcher | null>(null);
  useEffect(() => setSupported(canWatchFolders()), []);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    let made: WebFolderWatcher | null = null;
    void import("@/lib/webFolderWatch").then(({ WebFolderWatcher: Watcher }) => {
      if (!live) return;
      made = new Watcher(
        {
          all: () => idbAll<StoredFolder>("watchFolders"),
          put: (f) => idbSet("watchFolders", f.id, f),
          remove: (id) => idbDelete("watchFolders", id),
        },
        // dicom-parser loads on the first probe, not with the page.
        async () => {
          const m = await import("dicom-parser");
          return { parseDicom: (bytes: Uint8Array, options?: { untilTag?: string }) => m.parseDicom(bytes, options as never) as never };
        },
        {
          now: () => Date.now(),
          visible: () => document.visibilityState !== "hidden",
          schedule: (fn, ms) => setTimeout(fn, ms),
          cancel: (t) => clearTimeout(t),
        }
      );
      made.onNewStudies = (_folder, studies) => setFresh((n) => n + studies.length);
      void made.init();
      setWatcher(made);
    });
    return () => {
      live = false;
      made?.dispose();
    };
  }, [supported]);
  return { supported, watcher, fresh, seen: () => setFresh(0) };
}

/** The entry: a button where watching works, a plain note where it does not. */
export function WatchFoldersEntry({
  supported,
  fresh,
  onOpen,
  dark,
  className,
  variant,
}: {
  supported: boolean;
  fresh: number;
  onOpen: () => void;
  dark?: boolean;
  /** Match the surrounding buttons (e.g. the free viewer landing's brand style). */
  className?: string;
  variant?: "imaging" | "ghost" | "secondary";
}) {
  if (!supported) {
    return (
      <p className={cn("text-xs", dark ? "text-white/60" : "text-muted")}>
        Watching a folder for new studies needs Chrome or Edge on a computer. In this browser, open folders with the button above.
      </p>
    );
  }
  return (
    <Button
      size="sm"
      variant={variant ?? (dark ? "imaging" : "ghost")}
      className={className}
      onClick={onOpen}
      leadingIcon={<FolderSync className="h-4 w-4" aria-hidden />}
    >
      Watched folders{fresh > 0 ? ` · ${fresh} new` : ""}
    </Button>
  );
}

