"use client";
// Export, as on FlowRad Viewer (desktop ExportDialog, Ctrl/⌘+E): the current
// image, the whole series as images, the series as video, or an anonymised
// DICOM copy. Everything is made in this browser and handed to its
// downloads; nothing is uploaded. Loaded on first use (CornerstoneViewer).
import { useEffect, useRef, useState } from "react";
import { FileImage, Film, FolderOutput, Images, ShieldCheck, TriangleAlert } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { cn } from "@/components/ui/cn";
import { BURNED_IN_WARNING } from "@flowrad/viewer-core/annotationPersistence";
import { anonymizeInstance } from "@/lib/dicomAnonymize";
import {
  anonymisedDicomPath,
  canvasBytes,
  downloadBlob,
  encodeMjpegAvi,
  encodeMp4,
  exportBaseName,
  seriesFrameName,
  videoSupport,
  zipBytes,
  type ExportOverlay,
} from "@/lib/viewerExport";

export type WebExportKind = "image" | "series" | "video" | "dicom";

/** The pane's stack, as the dialog needs it. */
export interface ExportFrames {
  count: number;
  /** Image on screen (0-based), restored after a series or video export. */
  current: number;
  modality?: string;
  seriesNumber?: number;
  /** Cine frame rate from the header, if any. */
  frameRate?: number;
  /** Show image i and resolve once it has rendered. */
  show: (index: number) => Promise<void>;
  /** The image on screen as a canvas (pixels, optional annotations and anonymous text). */
  capture: (options: { annotations: boolean; overlay: ExportOverlay }) => Promise<HTMLCanvasElement>;
}

/** The files behind the pane's series and its study (the anonymised DICOM copy). */
export interface ExportDicomFiles {
  series: File[];
  /** The study's files, grouped by series (so each series gets its own folder). */
  study: File[][];
}

interface Props {
  open: boolean;
  onClose: () => void;
  frames: ExportFrames | null;
  dicom?: ExportDicomFiles | null;
  initial?: { kind?: WebExportKind };
  /** A short confirmation on the viewer (the dialog has closed by then). */
  onDone: (message: string) => void;
}

const KINDS: { id: WebExportKind; label: string; hint: string; icon: typeof FileImage }[] = [
  { id: "image", label: "Image", hint: "PNG or JPEG of the current view", icon: FileImage },
  { id: "series", label: "Image series", hint: "Every image of the series, in one ZIP", icon: Images },
  { id: "video", label: "Video", hint: "The series as a cine clip", icon: Film },
  { id: "dicom", label: "DICOM (anonymised)", hint: "A de-identified copy of the series or study", icon: FolderOutput },
];

const SELECT =
  "h-9 rounded-lg border border-strong bg-elevated px-2 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50";

const randomSalt = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

export function WebExportDialog({ open, onClose, frames, dicom, initial, onDone }: Props) {
  const [kind, setKind] = useState<WebExportKind>(initial?.kind ?? "image");
  const [format, setFormat] = useState<"png" | "jpeg">("png");
  const [overlay, setOverlay] = useState<ExportOverlay>("anonymous");
  const [annotations, setAnnotations] = useState(true);
  const [fps, setFps] = useState(15);
  const [scope, setScope] = useState<"series" | "study">("series");
  const [removeDates, setRemoveDates] = useState(false);
  const [busy, setBusy] = useState<{ done: number; total: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [support, setSupport] = useState<{ mp4: boolean } | null>(null);

  useEffect(() => {
    if (open && !support) videoSupport().then(setSupport, () => setSupport({ mp4: false }));
  }, [open, support]);
  useEffect(() => {
    if (!open) return;
    setKind(initial?.kind ?? "image");
    setError(null);
  }, [open, initial?.kind]);
  useEffect(() => {
    if (open && frames?.frameRate) setFps(Math.min(60, Math.max(1, Math.round(frames.frameRate))));
  }, [open, frames?.frameRate]);

  const close = () => {
    abort.current?.abort();
    setBusy(null);
    onClose();
  };

  const count = frames?.count ?? 0;
  const dicomCount = scope === "study" ? (dicom?.study.reduce((n, s) => n + s.length, 0) ?? 0) : (dicom?.series.length ?? 0);
  const disabledReason = (k: WebExportKind): string | null => {
    if (!frames) return "Waiting for the image";
    if ((k === "series" || k === "video") && count < 2) return "This series has one image";
    if (k === "dicom" && !dicom?.series.length) return "Available once the whole study has loaded";
    return null;
  };

  const run = async () => {
    if (!frames || disabledReason(kind)) return;
    const controller = new AbortController();
    abort.current = controller;
    const signal = controller.signal;
    const base = exportBaseName({ modality: frames.modality, seriesNumber: frames.seriesNumber });
    const ext = format === "png" ? "png" : "jpg";
    const grab = () => frames.capture({ annotations, overlay });
    setError(null);
    try {
      if (kind === "image") {
        const bytes = await canvasBytes(await grab(), format);
        downloadBlob(new Blob([bytes as BlobPart], { type: format === "png" ? "image/png" : "image/jpeg" }), `${base}.${ext}`);
        onClose();
        onDone("Image exported");
        return;
      }
      if (kind === "series") {
        const entries: { name: string; bytes: Uint8Array }[] = [];
        setBusy({ done: 0, total: count, label: "Exporting images" });
        try {
          for (let i = 0; i < count; i += 1) {
            if (signal.aborted) throw new Error("cancelled");
            await frames.show(i);
            entries.push({ name: seriesFrameName(base, i, count, ext), bytes: await canvasBytes(await grab(), format) });
            setBusy({ done: i + 1, total: count, label: "Exporting images" });
          }
        } finally {
          await frames.show(frames.current);
        }
        downloadBlob(zipBytes(entries), `${base}_images.zip`);
        setBusy(null);
        onClose();
        onDone(`${count} images exported (ZIP)`);
        return;
      }
      if (kind === "video") {
        let mp4 = !!support?.mp4;
        const label = () => (mp4 ? "Encoding MP4 (H.264)" : "Encoding AVI (Motion JPEG)");
        setBusy({ done: 0, total: count, label: label() });
        const source = { count, showFrame: (i: number) => frames.show(i), capture: () => grab() };
        const progress = (done: number) => setBusy({ done, total: count, label: label() });
        let bytes: Uint8Array;
        try {
          try {
            bytes = mp4 ? await encodeMp4(source, fps, progress, signal) : await encodeMjpegAvi(source, fps, progress, signal);
          } catch (e) {
            if (!mp4 || signal.aborted) throw e;
            // The H.264 encoder failed mid-run: finish the job as AVI instead.
            mp4 = false;
            bytes = await encodeMjpegAvi(source, fps, progress, signal);
          }
        } finally {
          await frames.show(frames.current);
        }
        downloadBlob(new Blob([bytes as BlobPart], { type: mp4 ? "video/mp4" : "video/x-msvideo" }), `${base}.${mp4 ? "mp4" : "avi"}`);
        setBusy(null);
        onClose();
        onDone(`${mp4 ? "Video" : "Video (AVI)"} exported · ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB`);
        return;
      }
      // DICOM (anonymised): one ZIP, one folder per series, no original names.
      const groups = scope === "study" ? dicom!.study : [dicom!.series];
      const total = groups.reduce((n, g) => n + g.length, 0);
      const salt = randomSalt();
      const entries: { name: string; bytes: Uint8Array }[] = [];
      let failed = 0;
      let firstError = "";
      setBusy({ done: 0, total, label: "Writing anonymised DICOM" });
      let done = 0;
      for (const [s, group] of groups.entries()) {
        for (const [i, file] of group.entries()) {
          if (signal.aborted) throw new Error("cancelled");
          try {
            const out = anonymizeInstance(new Uint8Array(await file.arrayBuffer()), { uidSalt: salt, removeDates });
            entries.push({ name: anonymisedDicomPath(s, i), bytes: out.bytes });
          } catch (e) {
            failed += 1;
            firstError ||= e instanceof Error ? e.message : String(e);
          }
          done += 1;
          setBusy({ done, total, label: "Writing anonymised DICOM" });
        }
      }
      if (!entries.length) throw new Error(`No file could be anonymised: ${firstError}`);
      downloadBlob(zipBytes(entries), `${base}_anonymised_dicom.zip`);
      setBusy(null);
      onClose();
      onDone(failed ? `${entries.length} files anonymised, ${failed} skipped` : `${entries.length} files anonymised (ZIP)`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setBusy(null);
      if (message !== "cancelled") setError(message);
    }
  };

  const reason = disabledReason(kind);
  return (
    <Modal
      open={open}
      onClose={close}
      title="Export"
      description="Made in this browser and saved to your downloads. Nothing is uploaded."
      size="lg"
      tone="reading"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {busy ? "Cancel" : "Close"}
          </Button>
          <Button onClick={run} loading={!!busy} disabled={!!reason}>
            Export
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div role="radiogroup" aria-label="What to export" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {KINDS.map((k) => {
            const why = disabledReason(k.id);
            return (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={kind === k.id}
                aria-label={k.label}
                aria-describedby={`export-kind-${k.id}`}
                disabled={!!busy || !!why}
                title={why ?? undefined}
                onClick={() => setKind(k.id)}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40",
                  kind === k.id ? "border-accent bg-accent/10" : "border-subtle hover:border-strong hover:bg-elevated"
                )}
              >
                <k.icon className="mt-0.5 h-4 w-4 shrink-0 text-secondary" aria-hidden />
                <span>
                  <span className="block text-sm font-medium text-primary">{k.label}</span>
                  <span id={`export-kind-${k.id}`} className="block text-xs text-muted">
                    {why ?? k.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {kind !== "dicom" ? (
          <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            {kind !== "video" ? (
              <label className="flex flex-col gap-1 text-secondary">
                Format
                <select value={format} disabled={!!busy} onChange={(e) => setFormat(e.target.value as "png" | "jpeg")} className={SELECT}>
                  <option value="png">PNG (lossless)</option>
                  <option value="jpeg">JPEG</option>
                </select>
              </label>
            ) : (
              <label className="flex flex-col gap-1 text-secondary">
                Frames per second
                <select value={fps} disabled={!!busy} onChange={(e) => setFps(Number(e.target.value))} className={cn(SELECT, "tabular-nums")}>
                  {[5, 10, 15, 20, 25, 30, 60].map((f) => (
                    <option key={f} value={f}>
                      {f} fps
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted" data-testid="export-video-format">
                  {!support
                    ? "Checking video encoders…"
                    : support.mp4
                      ? "MP4 (H.264), encoded faster than real time."
                      : "AVI (Motion JPEG): this browser has no H.264 encoder. Plays in VLC, Windows Media Player and QuickTime."}
                </span>
              </label>
            )}
            <label className="flex flex-col gap-1 text-secondary">
              Text on the image
              <select value={overlay} disabled={!!busy} onChange={(e) => setOverlay(e.target.value as ExportOverlay)} className={SELECT}>
                <option value="anonymous">Anonymous (series, image, window)</option>
                <option value="none">None</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-secondary sm:col-span-2">
              <input
                type="checkbox"
                checked={annotations}
                disabled={!!busy}
                onChange={(e) => setAnnotations(e.target.checked)}
                className="h-4 w-4 accent-[rgb(var(--accent))]"
              />
              Include measurements and annotations
            </label>
            {annotations && (
              <p className="flex items-start gap-2 rounded-lg border border-subtle bg-surface p-2 text-xs text-secondary sm:col-span-2">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
                {BURNED_IN_WARNING}
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 text-sm">
            <label className="flex flex-col gap-1 text-secondary">
              Scope
              <select value={scope} disabled={!!busy} onChange={(e) => setScope(e.target.value as "series" | "study")} className={SELECT}>
                <option value="series">This series ({dicom?.series.length ?? 0} files)</option>
                <option value="study">
                  Whole study ({dicom?.study.reduce((n, s) => n + s.length, 0) ?? 0} files, {dicom?.study.length ?? 0} series)
                </option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-secondary">
              <input
                type="checkbox"
                checked={removeDates}
                disabled={!!busy}
                onChange={(e) => setRemoveDates(e.target.checked)}
                className="h-4 w-4 accent-[rgb(var(--accent))]"
              />
              Also remove study and series dates (keep them to compare priors)
            </label>
            <div className="rounded-lg border border-subtle bg-surface p-3 text-xs text-secondary">
              <p className="flex items-center gap-1.5 font-medium text-success">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> DICOM PS3.15 basic profile header scrub
              </p>
              <p className="mt-1">
                Removes names, IDs, birth date, addresses, physicians, institution and private tags; remaps study, series
                and instance UIDs consistently; files are renamed so folder names cannot carry identifiers. Pixels are not
                inspected: text burned into the image (common on ultrasound and scanned documents) is not removed.
              </p>
            </div>
            <p className="text-xs text-muted tabular-nums">{dicomCount} files will be written to one ZIP.</p>
          </div>
        )}

        {busy && (
          <div role="status" aria-live="polite" className="flex flex-col gap-1.5">
            <div className="flex justify-between text-xs text-secondary tabular-nums">
              <span>{busy.label}</span>
              <span>
                {busy.done} / {busy.total}
              </span>
            </div>
            <ProgressBar value={busy.done / Math.max(1, busy.total)} label={busy.label} valueText={`${busy.done} of ${busy.total}`} />
          </div>
        )}
        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-2 text-xs text-danger">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Export failed: {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
