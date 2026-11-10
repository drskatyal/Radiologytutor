// Folder watching in the browser (Chrome / Edge: File System Access API).
//
// * Only with the reader's explicit choice: a folder picked in the browser's
//   own picker, read-only (`mode: "read"`). Nothing is uploaded; studies open
//   in this tab like any local folder.
// * Polling runs only while this tab is open, and pauses while it is hidden.
// * Folder handles are remembered in this browser (IndexedDB). After a reload
//   the browser asks again: the folder shows "Allow again", and only a click
//   (a user gesture) re-requests read permission.
// * The shared engine decides what to read (packages/viewer-core/src/
//   folderWatch.ts): stable files only, SOP UID dedupe, bounded, no patient
//   identifiers in summaries. Non-DICOM / proprietary files are skipped.
// * Safari and Firefox have no directory handles: `folderWatchSupported()` is
//   false and the UI shows that state instead of controls.

import { FolderWatchEngine, watchRetryDelayMs, type ListedFile, type ProbedFile, type WatchedStudy, type WatchStatus } from "@flowrad/viewer-core/folderWatch";
import { isObviouslyNotDicom } from "@flowrad/viewer-core/localStudy";
import { parseLocalHeaderProgressive, type DicomHeaderParser } from "@flowrad/viewer-core/localHeader";

export const WEB_POLL_MS = 10_000;
export const WEB_MAX_LIST = 200_001;

type DirHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>;
  queryPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
};

export function folderWatchSupported(w: unknown = typeof window === "undefined" ? undefined : window): boolean {
  const win = w as { showDirectoryPicker?: unknown; FileSystemHandle?: { prototype?: { queryPermission?: unknown } } } | undefined;
  return !!win && typeof win.showDirectoryPicker === "function" && typeof win.FileSystemHandle?.prototype?.queryPermission === "function";
}

export interface StoredFolder {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  enabled: boolean;
}

export interface FolderStore {
  all(): Promise<StoredFolder[]>;
  put(f: StoredFolder): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface WebFolderView {
  id: string;
  name: string;
  enabled: boolean;
  status: WatchStatus;
  studies: WatchedStudy[];
  skipped: number;
}

/** Bounded recursive listing; files keyed by their path inside the folder. */
export async function listDirectory(root: FileSystemDirectoryHandle, cap = WEB_MAX_LIST): Promise<{ listing: ListedFile[]; files: Map<string, FileSystemFileHandle> }> {
  const listing: ListedFile[] = [];
  const files = new Map<string, FileSystemFileHandle>();
  const walk = async (dir: DirHandle, prefix: string): Promise<void> => {
    for await (const h of dir.values()) {
      if (listing.length >= cap) return;
      if (h.name.startsWith(".") || h.name === "__MACOSX") continue;
      const path = prefix ? `${prefix}/${h.name}` : h.name;
      if (h.kind === "directory") {
        await walk(h as DirHandle, path);
        continue;
      }
      if (isObviouslyNotDicom(h.name)) continue;
      try {
        const f = await (h as FileSystemFileHandle).getFile();
        listing.push({ path, size: f.size, mtimeMs: f.lastModified });
        files.set(path, h as FileSystemFileHandle);
      } catch {
        // Unreadable now (being written, permission): next poll.
      }
    }
  };
  await walk(root as DirHandle, "");
  return { listing, files };
}

export async function probeFile(parser: DicomHeaderParser, file: File): Promise<ProbedFile | null> {
  try {
    const h = await parseLocalHeaderProgressive(parser, file.name, file.size, async (end) => new Uint8Array(await file.slice(0, Math.min(end, file.size)).arrayBuffer()));
    if (!h) return null;
    return {
      sopInstanceUID: h.sopInstanceUID,
      studyInstanceUID: h.studyInstanceUID,
      seriesInstanceUID: h.seriesInstanceUID,
      modality: h.modality,
      studyDescription: h.studyDescription,
      studyDate: h.studyDate,
    };
  } catch {
    return null;
  }
}

interface Runner {
  folder: StoredFolder;
  engine: FolderWatchEngine;
  status: WatchStatus;
  files: Map<string, FileSystemFileHandle>;
  timer: ReturnType<typeof setTimeout> | null;
  errors: number;
  busy: boolean;
  epoch: number;
}

export class WebFolderWatcher {
  private runners = new Map<string, Runner>();
  private listeners = new Set<() => void>();
  private view: WebFolderView[] = [];
  private onVisibility = () => this.resumeIfVisible();
  onNewStudies?: (folder: string, studies: WatchedStudy[]) => void;

  constructor(
    private store: FolderStore,
    private parser: () => Promise<DicomHeaderParser>,
    private env: {
      now: () => number;
      visible: () => boolean;
      schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
      cancel: (t: ReturnType<typeof setTimeout>) => void;
      pick?: () => Promise<FileSystemDirectoryHandle>;
    }
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): WebFolderView[] {
    return this.view;
  }

  private emit() {
    this.view = [...this.runners.values()].map((r) => ({
      id: r.folder.id,
      name: r.folder.name,
      enabled: r.folder.enabled,
      status: r.status,
      studies: r.engine.studies(),
      skipped: r.engine.skippedTotal,
    }));
    this.listeners.forEach((l) => l());
  }

  async init(): Promise<void> {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
    for (const folder of await this.store.all()) {
      const r = this.runner(folder);
      if (!folder.enabled) r.status = { state: "stopped" };
      else if ((await this.permission(folder.handle, false)) === "granted") this.kick(r);
      else r.status = { state: "permission", message: "The browser needs your permission again to read this folder." };
    }
    this.emit();
  }

  dispose() {
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    for (const r of this.runners.values()) this.halt(r);
  }

  /** Pick a folder (must run from a click). */
  async add(): Promise<void> {
    const pick = this.env.pick ?? (() => (window as unknown as { showDirectoryPicker: (o: { mode: "read" }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: "read" }));
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await pick();
    } catch {
      return; // cancelled
    }
    for (const r of this.runners.values()) {
      if (await r.folder.handle.isSameEntry?.(handle).catch(() => false)) return;
    }
    const folder: StoredFolder = { id: `wf-${Date.now().toString(36)}`, name: handle.name, handle, enabled: true };
    await this.store.put(folder);
    this.kick(this.runner(folder));
    this.emit();
  }

  /** "Allow again" after a reload (must run from a click). */
  async reconnect(id: string): Promise<void> {
    const r = this.runners.get(id);
    if (!r) return;
    if ((await this.permission(r.folder.handle, true)) === "granted") {
      r.folder.enabled = true;
      await this.store.put(r.folder);
      this.kick(r);
    } else r.status = { state: "permission", message: "Permission was not given, so the folder is not read." };
    this.emit();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const r = this.runners.get(id);
    if (!r) return;
    r.folder.enabled = enabled;
    await this.store.put(r.folder);
    if (!enabled) {
      this.halt(r);
      r.status = { state: "stopped" };
    } else if ((await this.permission(r.folder.handle, false)) === "granted") this.kick(r);
    else r.status = { state: "permission", message: "The browser needs your permission again to read this folder." };
    this.emit();
  }

  async remove(id: string): Promise<void> {
    const r = this.runners.get(id);
    if (r) this.halt(r);
    this.runners.delete(id);
    await this.store.remove(id);
    this.emit();
  }

  pollNow(id: string): Promise<void> {
    const r = this.runners.get(id);
    return r ? this.poll(r) : Promise.resolve();
  }

  /** The study's files, read now (read-only), for opening in this tab. */
  async filesOf(id: string, key: string): Promise<File[]> {
    const r = this.runners.get(id);
    if (!r) return [];
    const out: File[] = [];
    for (const path of r.engine.filesOf(key)) {
      const h = r.files.get(path);
      if (!h) continue;
      try {
        const f = await h.getFile();
        Object.defineProperty(f, "webkitRelativePath", { value: `${r.folder.name}/${path}`, configurable: true });
        out.push(f);
      } catch {
        /* gone since the last poll */
      }
    }
    return out;
  }

  private runner(folder: StoredFolder): Runner {
    let r = this.runners.get(folder.id);
    if (!r) {
      r = { folder, engine: new FolderWatchEngine(), status: { state: "idle" }, files: new Map(), timer: null, errors: 0, busy: false, epoch: 0 };
      this.runners.set(folder.id, r);
    }
    return r;
  }

  private async permission(handle: FileSystemDirectoryHandle, request: boolean): Promise<PermissionState> {
    const h = handle as DirHandle;
    try {
      const now = (await h.queryPermission?.({ mode: "read" })) ?? "granted";
      if (now === "granted" || !request) return now;
      return (await h.requestPermission?.({ mode: "read" })) ?? "denied";
    } catch {
      return "denied";
    }
  }

  private halt(r: Runner) {
    if (r.timer) this.env.cancel(r.timer);
    r.timer = null;
    r.epoch += 1;
  }

  private kick(r: Runner) {
    this.halt(r);
    void this.poll(r);
  }

  private resumeIfVisible() {
    if (!this.env.visible()) return;
    for (const r of this.runners.values()) if (r.folder.enabled && r.status.state === "watching" && !r.busy) this.kick(r);
  }

  private later(r: Runner, ms: number) {
    if (r.timer) this.env.cancel(r.timer);
    const epoch = r.epoch;
    r.timer = this.env.schedule(() => {
      if (r.epoch !== epoch) return;
      // Hidden tab: no polling until it is shown again (visibilitychange).
      if (!this.env.visible()) return;
      void this.poll(r);
    }, ms);
  }

  private async poll(r: Runner): Promise<void> {
    if (!r.folder.enabled || r.busy) return;
    r.busy = true;
    const epoch = r.epoch;
    const first = r.engine.trackedCount === 0;
    try {
      if ((await this.permission(r.folder.handle, false)) !== "granted") {
        r.status = { state: "permission", message: "The browser needs your permission again to read this folder." };
        return;
      }
      const { listing, files } = await listDirectory(r.folder.handle);
      if (r.epoch !== epoch) return;
      r.files = files;
      const seen = r.engine.observe(listing, this.env.now());
      const before = new Set(r.engine.studies().map((s) => s.key));
      if (seen.ready.length) {
        const parser = await this.parser();
        const probes = await Promise.all(
          seen.ready.map(async (path) => {
            const h = files.get(path);
            if (!h) return null;
            try {
              return await probeFile(parser, await h.getFile());
            } catch {
              return null;
            }
          })
        );
        if (r.epoch !== epoch) return;
        r.engine.ingest(seen.ready, probes, this.env.now());
      }
      const fresh = r.engine.studies().filter((s) => !before.has(s.key));
      if (fresh.length && !first) this.onNewStudies?.(r.folder.name, fresh);
      r.errors = 0;
      r.status = { state: "watching", lastPollMs: this.env.now(), waiting: seen.waiting, truncated: seen.truncated };
      this.later(r, seen.ready.length >= r.engine.options.maxProbePerPoll ? 250 : WEB_POLL_MS);
    } catch {
      if (r.epoch !== epoch) return;
      r.errors += 1;
      const retryInMs = watchRetryDelayMs(r.errors);
      r.status = { state: "error", message: "The folder could not be read (moved, renamed or disconnected).", retryInMs };
      this.later(r, retryInMs);
    } finally {
      r.busy = false;
      if (r.epoch === epoch) this.emit();
    }
  }
}
