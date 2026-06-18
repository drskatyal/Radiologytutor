"use client";

// Upload a DICOM study to our own backend (Orthanc) and open it in our viewer.
// Pick a folder/files of .dcm → POST /api/upload → Orthanc stores them → we get
// back the study/series UIDs → "View" opens /cornerstone?study=&series=.
//
// De-identification is not wired yet: upload only already-anonymized studies.

import Link from "next/link";
import { useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Spinner,
  useToast,
} from "@/components/ui";
import { PageHeader } from "@/components/AppShell";

interface SeriesOut {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  description: string;
  instances: number;
}
interface UploadResult {
  stored: number;
  series: SeriesOut[];
  errors: string[];
}

export default function UploadPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);
  const { toast } = useToast();

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setResult(null);
    setStatus(`Uploading ${files.length} file(s)…`);
    try {
      const form = new FormData();
      Array.from(files).forEach((f) => form.append("files", f));
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Error: ${data.error || res.status}`);
        toast({
          title: "Upload failed",
          description: String(data.error || res.status),
          variant: "danger",
        });
        return;
      }
      setResult(data as UploadResult);
      setStatus(
        `Stored ${data.stored} instance(s) in ${data.series.length} series.`
      );
      toast({
        title: "Upload complete",
        description: `${data.stored} instance(s) in ${data.series.length} series.`,
        variant: "success",
      });
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
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
    <>
      <PageHeader
        title="Upload a case"
        description="Add a DICOM study (folder or files). It's stored in our own backend and opens in our viewer. Upload only already-anonymized studies for now."
      />

      <div className="mx-auto max-w-3xl px-6 py-8">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleUpload(e.dataTransfer.files);
          }}
          className={[
            "flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors",
            dragging
              ? "border-accent bg-accent/5"
              : "border-strong bg-surface hover:border-accent/50",
          ].join(" ")}
        >
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-elevated text-secondary">
            {busy ? (
              <Spinner size="md" label="Uploading" />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-6 w-6">
                <path d="M12 16V4M7 9l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
              </svg>
            )}
          </div>
          <p className="text-sm text-secondary">Drag &amp; drop a DICOM study here</p>
          <p className="mb-5 mt-1 text-xs text-muted">or pick a folder of .dcm files</p>
          <Button loading={busy} onClick={() => inputRef.current?.click()}>
            {busy ? "Uploading…" : "Choose files"}
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            // @ts-expect-error — non-standard but widely supported folder picker
            webkitdirectory=""
            className="hidden"
            onChange={(e) => handleUpload(e.target.files)}
          />
        </div>

        {status && !result && (
          <p className="mt-4 text-sm text-muted">{status}</p>
        )}

        {result && result.series.length > 0 && (
          <div className="mt-8">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-primary">Stored series</h2>
              <Badge variant="success" dot>
                {result.stored} instance{result.stored === 1 ? "" : "s"}
              </Badge>
            </div>
            <div className="flex flex-col gap-2">
              {result.series.map((s) => (
                <Card
                  key={s.seriesInstanceUID}
                  padded={false}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-primary">
                      {s.description || "Untitled series"}
                    </div>
                    <div className="mt-0.5 text-xs tabular-nums text-muted">
                      {s.instances} image{s.instances === 1 ? "" : "s"}
                    </div>
                  </div>
                  <Link
                    href={`/cornerstone?study=${encodeURIComponent(s.studyInstanceUID)}&series=${encodeURIComponent(s.seriesInstanceUID)}`}
                    className="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-lg border border-strong bg-elevated px-3 text-xs font-medium text-primary transition-colors hover:bg-elevated/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                  >
                    View
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-3.5 w-3.5">
                      <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </Link>
                </Card>
              ))}
            </div>
          </div>
        )}

        {result && result.series.length === 0 && result.errors.length === 0 && (
          <div className="mt-8">
            <EmptyState
              title="No series found"
              description="The upload completed but no DICOM series were detected."
            />
          </div>
        )}

        {result && result.errors.length > 0 && (
          <Card className="mt-6 border-danger/30 bg-danger/5">
            <h3 className="mb-2 text-sm font-semibold text-danger">
              {result.errors.length} error
              {result.errors.length === 1 ? "" : "s"}
            </h3>
            <pre className="whitespace-pre-wrap break-words text-xs text-danger/90">
              {result.errors.join("\n")}
            </pre>
          </Card>
        )}
      </div>
    </>
  );
}
