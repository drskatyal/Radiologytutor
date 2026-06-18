"use client";

// Reusable DICOM upload control for the admin create-case flow.
//
// A radiologist drops a folder, a pile of loose .dcm files, or a single .zip
// exported from a PACS. We:
//   • filter out obvious junk (DICOMDIR, .DS_Store, JPEGs, PDFs…) client-side
//     and tell the user what was skipped and why;
//   • upload in small SEQUENTIAL batches (so a 300-slice study can't blow up a
//     single request or freeze the tab) with real overall progress + counts;
//   • let the user CANCEL mid-upload without losing the slices already stored;
//   • on partial failure, surface how many failed and offer "retry failed";
//   • detect a missing imaging archive (HTTP 503) and degrade calmly.
//
// Each successful batch's series are reported to the parent via onUploaded; the
// parent groups them into studies (deduped by StudyInstanceUID).

import { useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import { Badge, Button, Spinner, useToast } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import {
  OrthancUnavailableError,
  type SkippedFile,
  type UploadResult,
} from "./types";
import { uploadDicomBatch } from "./api";

/** How many files we send per request. Keeps each POST small and resumable. */
const BATCH_SIZE = 20;

// Client-side mirror of the server's filter, so the count we show is honest
// before we ever hit the network. The server re-checks (incl. DICM magic).
const JUNK_NAMES = new Set(["dicomdir", ".ds_store", "thumbs.db", "desktop.ini"]);
const NON_DICOM_EXT =
  /\.(jpe?g|png|gif|bmp|tiff?|pdf|txt|xml|html?|json|csv|xlsx?|docx?|mp4|mov)$/i;

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Split a dropped/selected file list into DICOM candidates, zips, and skips. */
function triage(files: File[]): {
  candidates: File[];
  zips: File[];
  skipped: SkippedFile[];
} {
  const candidates: File[] = [];
  const zips: File[] = [];
  const skipped: SkippedFile[] = [];
  for (const f of files) {
    const name = baseName(f.webkitRelativePath || f.name).toLowerCase();
    if (/\.zip$/i.test(name)) {
      zips.push(f);
    } else if (JUNK_NAMES.has(name)) {
      skipped.push({ name: f.name, reason: "system file" });
    } else if (name.startsWith(".")) {
      skipped.push({ name: f.name, reason: "hidden file" });
    } else if (NON_DICOM_EXT.test(name)) {
      skipped.push({ name: f.name, reason: "not a DICOM file" });
    } else {
      // No-extension and .dcm both reach here; server confirms via DICM magic.
      candidates.push(f);
    }
  }
  return { candidates, zips, skipped };
}

/** Recursively read all files out of a dropped folder (drag-drop only). */
async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = Array.from(dt.items || []);
  const entries = items
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean) as FileSystemEntry[];
  if (entries.length === 0) return Array.from(dt.files);

  const out: File[] = [];
  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej)
      );
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns in chunks; keep reading until it's empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
          reader.readEntries(res, rej)
        );
        if (batch.length === 0) break;
        for (const e of batch) await walk(e);
      }
    }
  }
  try {
    await Promise.all(entries.map(walk));
  } catch {
    return Array.from(dt.files);
  }
  return out;
}

type Phase = "idle" | "uploading" | "done";

interface Progress {
  totalFiles: number;
  doneFiles: number;
  storedImages: number;
}

export function DicomDropzone({
  onUploaded,
  onImagingUnavailable,
  disabled,
}: {
  /** Called once per successful batch with that batch's series. */
  onUploaded: (result: UploadResult) => void;
  /** Called when the archive isn't connected (HTTP 503) so the parent can note it. */
  onImagingUnavailable?: (message: string) => void;
  disabled?: boolean;
}) {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [skipped, setSkipped] = useState<SkippedFile[]>([]);
  const [failed, setFailed] = useState<SkippedFile[]>([]);
  /** DICOM candidates that failed, kept so the user can retry just those. */
  const failedFilesRef = useRef<File[]>([]);
  const { toast } = useToast();

  const busy = phase === "uploading";

  function reset() {
    setProgress(null);
    setSkipped([]);
    setFailed([]);
    failedFilesRef.current = [];
  }

  function finalize(
    storedImages: number,
    accFailed: SkippedFile[],
    accFailedFiles: File[]
  ) {
    abortRef.current = null;
    setFailed(accFailed);
    failedFilesRef.current = accFailedFiles;
    setPhase(storedImages > 0 || accFailed.length ? "done" : "idle");
    if (storedImages > 0) {
      toast({
        title: "Study uploaded",
        description:
          accFailed.length > 0
            ? `${storedImages} image(s) stored · ${accFailed.length} failed.`
            : `${storedImages} image(s) stored.`,
        variant: accFailed.length > 0 ? "warning" : "success",
      });
    }
  }

  async function run(candidates: File[], zips: File[], preSkipped: SkippedFile[]) {
    const all = [...candidates, ...zips];
    if (all.length === 0) {
      if (preSkipped.length) {
        setSkipped(preSkipped);
        toast({
          title: "No DICOM images found",
          description: `${preSkipped.length} file(s) were skipped — none looked like DICOM.`,
          variant: "warning",
        });
      }
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("uploading");
    setFailed([]);
    failedFilesRef.current = [];
    setSkipped(preSkipped);

    // Batch zips one-per-request (each can be large); regular files in groups.
    const batches: File[][] = [];
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      batches.push(candidates.slice(i, i + BATCH_SIZE));
    }
    for (const z of zips) batches.push([z]);

    const totalFiles = all.length;
    let doneFiles = 0;
    let storedImages = 0;
    const accSkipped = [...preSkipped];
    const accFailed: SkippedFile[] = [];
    const accFailedFiles: File[] = [];
    setProgress({ totalFiles, doneFiles, storedImages });

    try {
      for (const batch of batches) {
        if (controller.signal.aborted) break;
        const result = await uploadDicomBatch(batch, { signal: controller.signal });
        doneFiles += batch.length;
        storedImages += result.stored;
        if (result.series.length) onUploaded(result);
        if (result.failed.length) {
          accFailed.push(...result.failed);
          for (const f of result.failed) {
            const match = batch.find((b) => b.name === f.name);
            if (match) accFailedFiles.push(match);
          }
        }
        if (result.skipped.length) accSkipped.push(...result.skipped);
        setProgress({ totalFiles, doneFiles, storedImages });
        setSkipped([...accSkipped]);
        setFailed([...accFailed]);
      }
    } catch (e) {
      if (e instanceof OrthancUnavailableError) {
        setPhase("idle");
        setProgress(null);
        onImagingUnavailable?.(e.message);
        return;
      }
      if ((e as DOMException)?.name === "AbortError") {
        toast({
          title: "Upload cancelled",
          description:
            storedImages > 0
              ? `${storedImages} image(s) were already saved and are kept.`
              : "No images were uploaded.",
          variant: "warning",
        });
        finalize(storedImages, accFailed, accFailedFiles);
        return;
      }
      toast({
        title: "Upload error",
        description: (e as Error).message,
        variant: "danger",
      });
    }

    finalize(storedImages, accFailed, accFailedFiles);
  }

  async function handleSelected(files: File[]) {
    if (busy || disabled || files.length === 0) return;
    reset();
    const triaged = triage(files);
    await run(triaged.candidates, triaged.zips, triaged.skipped);
  }

  async function retryFailed() {
    const files = failedFilesRef.current;
    if (files.length === 0 || busy) return;
    setFailed([]);
    await run(files, [], skipped);
  }

  function cancel() {
    abortRef.current?.abort();
  }

  const pct =
    progress && progress.totalFiles > 0
      ? Math.round((progress.doneFiles / progress.totalFiles) * 100)
      : 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled && !busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDragging(false);
          if (disabled || busy) return;
          const files = await filesFromDataTransfer(e.dataTransfer);
          handleSelected(files);
        }}
        className={cn(
          "flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-9 text-center transition-colors",
          disabled
            ? "border-subtle opacity-60"
            : dragging
              ? "border-accent bg-accent/5"
              : "border-strong bg-surface hover:border-accent/50"
        )}
      >
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-elevated text-secondary">
          {busy ? (
            <Spinner size="md" label="Uploading" />
          ) : (
            <UploadCloud className="h-6 w-6" aria-hidden="true" />
          )}
        </div>
        <p className="text-sm text-secondary">
          {busy ? "Uploading study…" : "Drag & drop a DICOM study, folder, or .zip"}
        </p>
        <p className="mb-4 mt-1 text-xs text-muted">
          {busy
            ? "Please keep this dialog open until it finishes."
            : "Loose .dcm files, a whole folder, or a PACS export .zip · upload only anonymized studies"}
        </p>

        {busy ? (
          <div className="flex w-full max-w-sm flex-col items-center gap-2">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-elevated"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Upload progress"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
            {progress && (
              <span className="text-xs tabular-nums text-muted">
                {progress.doneFiles} of {progress.totalFiles} files ·{" "}
                {progress.storedImages} image{progress.storedImages === 1 ? "" : "s"} stored
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={cancel}>
              Cancel upload
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => folderInputRef.current?.click()}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-lg border border-strong bg-elevated px-3.5 text-xs font-medium text-primary",
                "transition-colors hover:bg-elevated/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
                "disabled:pointer-events-none disabled:opacity-50"
              )}
            >
              Choose folder
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-lg border border-strong bg-elevated px-3.5 text-xs font-medium text-primary",
                "transition-colors hover:bg-elevated/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
                "disabled:pointer-events-none disabled:opacity-50"
              )}
            >
              Choose files or .zip
            </button>
          </div>
        )}

        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-expect-error — non-standard but widely supported folder picker
          webkitdirectory=""
          className="hidden"
          onChange={(e) => {
            handleSelected(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".dcm,.zip,application/dicom,application/zip"
          className="hidden"
          onChange={(e) => {
            handleSelected(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>

      {/* Partial-failure panel with retry. */}
      {failed.length > 0 && !busy && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-3.5 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-warning">
              {failed.length} file{failed.length === 1 ? "" : "s"} didn’t upload
            </p>
            {failedFilesRef.current.length > 0 && (
              <Button size="sm" variant="secondary" onClick={retryFailed}>
                Retry failed
              </Button>
            )}
          </div>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-muted">
            {failed.slice(0, 5).map((f, i) => (
              <li key={`${f.name}-${i}`} className="truncate">
                <span className="text-secondary">{f.name}</span> — {f.reason}
              </li>
            ))}
            {failed.length > 5 && <li>…and {failed.length - 5} more.</li>}
          </ul>
        </div>
      )}

      {/* Skipped (non-DICOM) summary. */}
      {skipped.length > 0 && !busy && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge variant="neutral">{skipped.length} skipped</Badge>
          <span className="min-w-0 truncate">
            {summarizeSkips(skipped)} — only DICOM images are uploaded.
          </span>
        </div>
      )}
    </div>
  );
}

/** "3 not a DICOM file, 1 system file" — a compact reason rollup. */
function summarizeSkips(skipped: SkippedFile[]): string {
  const byReason = new Map<string, number>();
  for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  return [...byReason.entries()].map(([reason, n]) => `${n} ${reason}`).join(", ");
}
