// Folder watching: new DICOM studies appear in a folder the reader chose.
//
// Pure engine shared by the web (File System Access handles, polled while the
// tab is open) and the desktop (the shell lists and probes; nothing here
// touches a file system). Read-only by contract: the engine only ever sees a
// listing and header probes. Rules:
//
//   stabilisation  a file is read only after its size and modification time
//                  were identical in two consecutive listings AND it is at
//                  least `settleMs` old: a study still being copied (or a
//                  PACS cache still writing) is never read half-written. A
//                  file that changes after being read is read again.
//   dedupe         by SOP Instance UID: the same instance in two places (a
//                  PACS cache's copy, a re-sent study) counts once.
//   bounds         at most `maxTracked` files tracked, `maxProbePerPoll`
//                  read per poll (the rest wait: back-pressure, not a burst),
//                  `maxStudies` studies kept (least recently updated dropped).
//   privacy        summaries carry no patient name, ID or birth date, and the
//                  study key is a hash, not the Study Instance UID.
//   not DICOM      unreadable, proprietary or encrypted files are skipped and
//                  counted, never decoded around.

export interface ListedFile {
  /** Opaque path (desktop: absolute path; web: path within the picked folder). */
  path: string;
  size: number;
  mtimeMs: number;
}

/** What a header probe returns for a standard, readable DICOM file. */
export interface ProbedFile {
  sopInstanceUID?: string | null;
  studyInstanceUID?: string | null;
  seriesInstanceUID?: string | null;
  modality?: string | null;
  studyDescription?: string | null;
  studyDate?: string | null;
}

export interface WatchOptions {
  settleMs: number;
  maxTracked: number;
  maxProbePerPoll: number;
  maxStudies: number;
}

export const DEFAULT_WATCH_OPTIONS: WatchOptions = {
  settleMs: 3000,
  maxTracked: 200_000,
  maxProbePerPoll: 400,
  maxStudies: 200,
};

export interface WatchedStudy {
  /** Hash of the Study Instance UID (stable across polls and sessions). */
  key: string;
  description: string;
  /** DICOM date (YYYYMMDD) or "". */
  date: string;
  modalities: string[];
  seriesCount: number;
  imageCount: number;
  firstSeenMs: number;
  updatedMs: number;
}

export interface ObserveResult {
  /** Files stable and due for a header probe, at most `maxProbePerPoll`. */
  ready: string[];
  /** Files seen but not yet stable (or waiting behind the per-poll cap). */
  waiting: number;
  /** The folder holds more files than `maxTracked`: the rest are ignored. */
  truncated: boolean;
}

export interface IngestResult {
  /** Studies created or grown by this batch. */
  changed: WatchedStudy[];
  newStudies: number;
  added: number;
  duplicates: number;
  skipped: number;
}

/** FNV-1a 64-bit as 16 hex digits: a stable, non-reversible-enough key for UIDs. */
export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i += 1) {
    h ^= BigInt(text.charCodeAt(i) & 0xffff);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

interface Tracked {
  size: number;
  mtimeMs: number;
  sameCount: number;
  state: "pending" | "read" | "skipped";
  sop?: string;
  study?: string;
}

interface StudyEntry extends WatchedStudy {
  files: Set<string>;
  series: Set<string>;
  sops: Set<string>;
  mods: Set<string>;
}

export class FolderWatchEngine {
  readonly options: WatchOptions;
  private tracked = new Map<string, Tracked>();
  private sops = new Map<string, string>(); // SOP UID → path
  private studyMap = new Map<string, StudyEntry>();
  skippedTotal = 0;
  duplicateTotal = 0;

  constructor(options: Partial<WatchOptions> = {}) {
    this.options = { ...DEFAULT_WATCH_OPTIONS, ...options };
  }

  /** A full listing of the folder at time `nowMs`. */
  observe(listing: readonly ListedFile[], nowMs: number): ObserveResult {
    const present = new Set<string>();
    const ready: string[] = [];
    let waiting = 0;
    let truncated = false;
    for (const f of listing) {
      present.add(f.path);
      const t = this.tracked.get(f.path);
      if (!t) {
        if (this.tracked.size >= this.options.maxTracked) {
          truncated = true;
          continue;
        }
        this.tracked.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, sameCount: 0, state: "pending" });
        waiting += 1;
        continue;
      }
      if (t.size !== f.size || t.mtimeMs !== f.mtimeMs) {
        // Still being written, or rewritten after we read it: start over.
        if (t.state === "read") this.forget(f.path, t);
        t.size = f.size;
        t.mtimeMs = f.mtimeMs;
        t.sameCount = 0;
        t.state = "pending";
        waiting += 1;
        continue;
      }
      if (t.state !== "pending") continue;
      t.sameCount += 1;
      const settled = nowMs - f.mtimeMs >= this.options.settleMs;
      if (t.sameCount >= 1 && settled && f.size > 0 && ready.length < this.options.maxProbePerPoll) ready.push(f.path);
      else waiting += 1;
    }
    // Files gone from the folder.
    for (const [path, t] of this.tracked) {
      if (present.has(path)) continue;
      if (t.state === "read") this.forget(path, t);
      this.tracked.delete(path);
    }
    return { ready, waiting, truncated };
  }

  /** Header probes for `paths` (null = not standard readable DICOM). */
  ingest(paths: readonly string[], probes: readonly (ProbedFile | null)[], nowMs: number): IngestResult {
    const changed = new Set<StudyEntry>();
    let added = 0;
    let duplicates = 0;
    let skipped = 0;
    let newStudies = 0;
    paths.forEach((path, i) => {
      const t = this.tracked.get(path);
      if (!t || t.state !== "pending") return;
      const p = probes[i];
      if (!p) {
        t.state = "skipped";
        skipped += 1;
        return;
      }
      const sop = p.sopInstanceUID || `path:${path}`;
      const owner = this.sops.get(sop);
      if (owner && owner !== path) {
        t.state = "skipped";
        duplicates += 1;
        return;
      }
      const key = fnv1a64(p.studyInstanceUID || "unknown-study");
      let s = this.studyMap.get(key);
      if (!s) {
        s = {
          key,
          description: (p.studyDescription ?? "").trim(),
          date: (p.studyDate ?? "").trim(),
          modalities: [],
          seriesCount: 0,
          imageCount: 0,
          firstSeenMs: nowMs,
          updatedMs: nowMs,
          files: new Set(),
          series: new Set(),
          sops: new Set(),
          mods: new Set(),
        };
        this.studyMap.set(key, s);
        newStudies += 1;
      }
      t.state = "read";
      t.sop = sop;
      t.study = key;
      this.sops.set(sop, path);
      s.files.add(path);
      s.sops.add(sop);
      if (p.seriesInstanceUID) s.series.add(p.seriesInstanceUID);
      if (p.modality) s.mods.add(p.modality.trim());
      if (!s.description && p.studyDescription) s.description = p.studyDescription.trim();
      s.updatedMs = nowMs;
      this.refresh(s);
      changed.add(s);
      added += 1;
    });
    this.skippedTotal += skipped;
    this.duplicateTotal += duplicates;
    this.evict();
    return { changed: [...changed].filter((s) => this.studyMap.has(s.key)).map(summary), newStudies, added, duplicates, skipped };
  }

  studies(): WatchedStudy[] {
    return [...this.studyMap.values()].sort((a, b) => b.updatedMs - a.updatedMs).map(summary);
  }

  /** Files of one study, for opening it (read-only). */
  filesOf(key: string): string[] {
    return [...(this.studyMap.get(key)?.files ?? [])].sort();
  }

  get trackedCount(): number {
    return this.tracked.size;
  }

  private forget(path: string, t: Tracked) {
    if (t.sop && this.sops.get(t.sop) === path) this.sops.delete(t.sop);
    const s = t.study ? this.studyMap.get(t.study) : undefined;
    if (s) {
      s.files.delete(path);
      if (t.sop) s.sops.delete(t.sop);
      this.refresh(s);
      if (s.files.size === 0) this.studyMap.delete(s.key);
    }
    t.sop = undefined;
    t.study = undefined;
  }

  private refresh(s: StudyEntry) {
    s.imageCount = s.sops.size;
    s.seriesCount = s.series.size;
    s.modalities = [...s.mods].sort();
  }

  private evict() {
    if (this.studyMap.size <= this.options.maxStudies) return;
    const oldest = [...this.studyMap.values()].sort((a, b) => a.updatedMs - b.updatedMs);
    for (const s of oldest.slice(0, this.studyMap.size - this.options.maxStudies)) {
      for (const path of s.files) {
        const t = this.tracked.get(path);
        // Stays tracked as read (so it is not probed again), but owns nothing.
        if (t) {
          if (t.sop) this.sops.delete(t.sop);
          t.sop = undefined;
          t.study = undefined;
        }
      }
      this.studyMap.delete(s.key);
    }
  }
}

function summary(s: StudyEntry): WatchedStudy {
  return {
    key: s.key,
    description: s.description,
    date: s.date,
    modalities: s.modalities,
    seriesCount: s.seriesCount,
    imageCount: s.imageCount,
    firstSeenMs: s.firstSeenMs,
    updatedMs: s.updatedMs,
  };
}

/** Poll delay after `errors` consecutive failures (folder gone, drive offline): 5 s → 60 s. */
export function watchRetryDelayMs(errors: number, baseMs = 5000): number {
  return Math.min(60_000, baseMs * 2 ** Math.max(0, Math.min(errors, 6)));
}

export type WatchStatus =
  | { state: "idle" }
  | { state: "watching"; lastPollMs: number; waiting: number; truncated: boolean }
  | { state: "error"; message: string; retryInMs: number }
  | { state: "permission"; message: string }
  | { state: "stopped" };
