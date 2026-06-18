"use client";

// Reusable DICOM upload control, folded out of the old /upload page. Picks a
// folder/files of .dcm → POST /api/upload (Orthanc) → reports the stored series.
// Used inside the admin create-case flow and the "add a prior study" flow.

import { useRef, useState } from "react";
import { Spinner, useToast } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { uploadDicom } from "./api";
import type { UploadResult } from "./types";

export function DicomDropzone({
  onUploaded,
  disabled,
}: {
  onUploaded: (result: UploadResult) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { toast } = useToast();

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0 || busy || disabled) return;
    setBusy(true);
    try {
      const result = await uploadDicom(files);
      if (result.errors.length && result.series.length === 0) {
        toast({
          title: "Upload failed",
          description: result.errors[0],
          variant: "danger",
        });
        return;
      }
      onUploaded(result);
      toast({
        title: "Study uploaded",
        description: `${result.stored} image(s) in ${result.series.length} series.`,
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "Upload failed",
        description: (e as Error).message,
        variant: "danger",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-6 w-6">
            <path d="M12 16V4M7 9l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
          </svg>
        )}
      </div>
      <p className="text-sm text-secondary">
        {busy ? "Uploading study…" : "Drag & drop a DICOM study"}
      </p>
      <p className="mb-4 mt-1 text-xs text-muted">
        or pick a folder of .dcm files · upload only anonymized studies
      </p>
      <button
        type="button"
        disabled={busy || disabled}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-lg border border-strong bg-elevated px-3.5 text-xs font-medium text-primary",
          "transition-colors hover:bg-elevated/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
          "disabled:pointer-events-none disabled:opacity-50"
        )}
      >
        Choose files
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        // @ts-expect-error — non-standard but widely supported folder picker
        webkitdirectory=""
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}
