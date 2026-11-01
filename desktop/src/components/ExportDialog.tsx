// Export: image, image series, video, or an anonymised DICOM copy.
// Anonymous by default (RadiAnt calls its equivalent "Basic (anonymous)").

import { useEffect, useRef, useState } from "react";
import { FileImage, Film, FolderOutput, Images, ShieldCheck, TriangleAlert } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Field } from "@/components/ui/Field";
import { useToast } from "../toast";
import { cn } from "@/components/ui/cn";
import { invoke, isTauri, listen, pickFolder, pickSavePath, writeExport } from "../platform";
import type { ViewerSeries, ViewerStudy } from "../types";
import { formatDicomDate, formatPersonName } from "../study";
import type { ViewportHandle } from "../viewer/handles";
import {
  canvasBytes,
  captureViewport,
  encodeMp4,
  encodeMjpegAvi,
  exportBaseName,
  videoSupport,
  type FrameText,
  type OverlayMode,
} from "../viewer/exporter";

export type ExportKind = "image" | "series" | "video" | "dicom";
type Kind = ExportKind;

interface Props {
  open: boolean;
  onClose: () => void;
  handle: ViewportHandle | undefined;
  series: ViewerSeries | null;
  study: ViewerStudy | null;
  /** Where the dialog opens (right-click "Save as PNG…": image, PNG, no burned-in text). */
  initial?: { kind?: Kind; format?: "png" | "jpeg"; overlay?: OverlayMode };
}

const KINDS: { id: Kind; label: string; hint: string; icon: typeof FileImage }[] = [
  { id: "image", label: "Image", hint: "PNG or JPEG of the current view", icon: FileImage },
  { id: "series", label: "Image series", hint: "Every image of the series, one file each", icon: Images },
  { id: "video", label: "Video", hint: "The series as a cine clip", icon: Film },
  { id: "dicom", label: "DICOM (anonymised)", hint: "A de-identified copy of the series or study", icon: FolderOutput },
];

function frameText(series: ViewerSeries, study: ViewerStudy | null, index: number, ww?: number, wc?: number): FrameText {
  const p = study?.patient;
  return {
    anonymous: [
      [series.modality, series.number != null ? `Se ${series.number}` : "", series.description].filter(Boolean).join(" · "),
      `Im ${index + 1} / ${series.imageCount}${ww != null ? ` · W ${Math.round(ww)} L ${Math.round(wc ?? 0)}` : ""}`,
    ],
    identifying: [
      formatPersonName(p?.name),
      [p?.id, p?.sex, formatDicomDate(p?.birthDate)].filter(Boolean).join(" · "),
      [study?.description, formatDicomDate(study?.date), study?.institution].filter(Boolean).join(" · "),
    ].filter(Boolean),
  };
}

export function ExportDialog({ open, onClose, handle, series, study, initial }: Props) {
  const { toast } = useToast();
  const [kind, setKind] = useState<Kind>(initial?.kind ?? "image");
  const [format, setFormat] = useState<"png" | "jpeg">(initial?.format ?? "png");
  const [overlay, setOverlay] = useState<OverlayMode>(initial?.overlay ?? "anonymous");
  const [annotations, setAnnotations] = useState(true);
  const [fps, setFps] = useState(15);
  const [dicomScope, setDicomScope] = useState<"series" | "study">("series");
  const [pseudoName, setPseudoName] = useState("ANONYMOUS");
  const [pseudoId, setPseudoId] = useState("ANON");
  const [keepDates, setKeepDates] = useState(true);
  const [busy, setBusy] = useState<{ done: number; total: number; label: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [support, setSupport] = useState<{ mp4: boolean } | null>(null);
  useEffect(() => {
    if (open && !support) videoSupport().then(setSupport, () => setSupport({ mp4: false }));
  }, [open, support]);

  useEffect(() => {
    if (open && series?.frameRate) setFps(Math.round(series.frameRate));
  }, [open, series?.frameRate]);

  const close = () => {
    abort.current?.abort();
    setBusy(null);
    onClose();
  };

  const base = exportBaseName({ modality: series?.modality, seriesNumber: series?.number });

  const run = async () => {
    if (!handle || !series) return;
    const controller = new AbortController();
    abort.current = controller;
    const options = (i: number) => {
      const r = handle.readout();
      return { overlay, annotations, text: frameText(series, study, i, r?.ww, r?.wc) };
    };
    try {
      if (kind === "image") {
        const path = await pickSavePath(`${base}.${format === "png" ? "png" : "jpg"}`, [format === "png" ? "png" : "jpg"], format.toUpperCase());
        if (!path && isTauri) return;
        const index = handle.readout()?.index ?? 0;
        const canvas = await captureViewport(handle.element, options(index));
        await writeExport(path ?? `${base}.png`, await canvasBytes(canvas, format));
        toast({ title: "Image exported", description: path ?? undefined, variant: "success" });
      } else if (kind === "series") {
        const folder = isTauri ? (await pickFolder("Choose a folder for the images"))?.[0] : "";
        if (folder == null) return;
        const sep = folder.includes("\\") ? "\\" : "/";
        const start = handle.readout()?.index ?? 0;
        setBusy({ done: 0, total: series.imageCount, label: "Exporting images" });
        for (let i = 0; i < series.imageCount; i += 1) {
          if (controller.signal.aborted) throw new Error("cancelled");
          await handle.renderFrame(i);
          const canvas = await captureViewport(handle.element, options(i));
          const name = `${base}_${String(i + 1).padStart(4, "0")}.${format === "png" ? "png" : "jpg"}`;
          await writeExport(folder ? `${folder}${sep}${name}` : name, await canvasBytes(canvas, format));
          setBusy({ done: i + 1, total: series.imageCount, label: "Exporting images" });
        }
        await handle.renderFrame(start);
        toast({ title: `${series.imageCount} images exported`, description: folder || undefined, variant: "success" });
      } else if (kind === "video") {
        let mp4 = !!support?.mp4;
        const ext = mp4 ? "mp4" : "avi";
        const path = await pickSavePath(`${base}.${ext}`, [ext], mp4 ? "MP4 video" : "AVI video (Motion JPEG)");
        if (!path && isTauri) return;
        const start = handle.readout()?.index ?? 0;
        const label = () => (mp4 ? "Encoding MP4 (H.264)" : "Encoding AVI (Motion JPEG)");
        setBusy({ done: 0, total: series.imageCount, label: label() });
        const source = {
          count: series.imageCount,
          showFrame: (i: number) => handle.renderFrame(i),
          capture: (i: number) => captureViewport(handle.element, { ...options(i), scale: 1 }),
        };
        const progress = (done: number) => setBusy({ done, total: series.imageCount, label: label() });
        let bytes: Uint8Array;
        let target = path ?? `${base}.${ext}`;
        try {
          bytes = mp4 ? await encodeMp4(source, fps, progress, controller.signal) : await encodeMjpegAvi(source, fps, progress, controller.signal);
        } catch (error) {
          if (!mp4 || controller.signal.aborted) throw error;
          // The H.264 encoder failed mid-run: finish the job as AVI instead.
          mp4 = false;
          target = target.replace(/\.mp4$/i, ".avi");
          bytes = await encodeMjpegAvi(source, fps, progress, controller.signal);
        }
        await writeExport(target, bytes);
        await handle.renderFrame(start);
        toast({ title: mp4 ? "Video exported" : "Video exported as AVI", description: `${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB · ${target}`, variant: "success" });
      } else {
        const folder = (await pickFolder("Choose an empty folder for the anonymised copy"))?.[0];
        if (!folder) return;
        const ids = [
          ...new Set(
            (dicomScope === "study" && study ? study.series.flatMap((s) => s.headers) : series.headers).map((h) => h.fileId)
          ),
        ];
        const paths = (await invoke<(string | null)[]>("paths_for_ids", { fileIds: ids })).filter((p): p is string => !!p);
        setBusy({ done: 0, total: paths.length, label: "Writing anonymised DICOM" });
        const off = await listen<{ done: number; total: number }>("export-progress", (p) =>
          setBusy({ done: p.done, total: p.total, label: "Writing anonymised DICOM" })
        );
        try {
          const result = await invoke<{ written: number; failed: number; errors: string[]; destination: string }>(
            "export_anonymized_dicom",
            {
              paths,
              destination: folder,
              options: {
                patientName: pseudoName.trim() || "ANONYMOUS",
                patientId: pseudoId.trim() || "ANON",
                keepAgeSex: true,
                removePrivate: true,
                remapUids: true,
                keepDates,
              },
            }
          );
          toast({
            title: result.failed ? `${result.written} written, ${result.failed} failed` : `${result.written} files anonymised`,
            description: result.failed ? result.errors[0] : result.destination,
            variant: result.failed ? "warning" : "success",
            duration: 8000,
          });
        } finally {
          off();
        }
      }
      close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "cancelled") toast({ title: "Export failed", description: message, variant: "danger", duration: 8000 });
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Export"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {busy ? "Cancel" : "Close"}
          </Button>
          <Button onClick={run} loading={!!busy} disabled={!handle || !series}>
            Export…
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div role="radiogroup" aria-label="What to export" className="grid grid-cols-2 gap-2">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              role="radio"
              aria-checked={kind === k.id}
              disabled={!!busy || (k.id === "dicom" && !isTauri)}
              onClick={() => setKind(k.id)}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40",
                kind === k.id ? "border-accent bg-accent-muted/40" : "border-subtle hover:border-strong hover:bg-elevated"
              )}
            >
              <k.icon className="mt-0.5 h-4 w-4 shrink-0 text-secondary" aria-hidden />
              <span>
                <span className="block text-sm font-medium text-primary">{k.label}</span>
                <span className="block text-xs text-muted">{k.hint}</span>
              </span>
            </button>
          ))}
        </div>

        {kind !== "dicom" ? (
          <div className="grid grid-cols-2 gap-4 text-sm">
            {kind !== "video" ? (
              <label className="flex flex-col gap-1 text-secondary">
                Format
                <select value={format} onChange={(e) => setFormat(e.target.value as "png" | "jpeg")} className="h-9 rounded-lg border border-strong bg-elevated px-2 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  <option value="png">PNG (lossless)</option>
                  <option value="jpeg">JPEG</option>
                </select>
              </label>
            ) : (
              <label className="flex flex-col gap-1 text-secondary">
                Frames per second
                <select value={fps} onChange={(e) => setFps(Number(e.target.value))} className="h-9 rounded-lg border border-strong bg-elevated px-2 text-primary tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {[5, 10, 15, 20, 25, 30, 60].map((f) => (
                    <option key={f} value={f}>
                      {f} fps
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted">
                  {!support
                    ? "Checking video encoders…"
                    : support.mp4
                      ? "MP4 (H.264), encoded faster than real time."
                      : "AVI (Motion JPEG): this system has no H.264 encoder. Plays in VLC, Windows Media Player and QuickTime."}
                </span>
              </label>
            )}
            <label className="flex flex-col gap-1 text-secondary">
              Text on the image
              <select value={overlay} onChange={(e) => setOverlay(e.target.value as OverlayMode)} className="h-9 rounded-lg border border-strong bg-elevated px-2 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <option value="anonymous">Anonymous (series, image, window)</option>
                <option value="none">None</option>
                <option value="full">Full overlay, with patient details</option>
              </select>
            </label>
            <label className="col-span-2 flex items-center gap-2 text-secondary">
              <input type="checkbox" checked={annotations} onChange={(e) => setAnnotations(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--accent))]" />
              Include measurements and annotations
            </label>
            {overlay === "full" && (
              <p className="col-span-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                The file will contain the patient&apos;s name, ID and date of birth.
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 text-sm">
            <label className="col-span-2 flex flex-col gap-1 text-secondary">
              Scope
              <select value={dicomScope} onChange={(e) => setDicomScope(e.target.value as "series" | "study")} className="h-9 rounded-lg border border-strong bg-elevated px-2 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <option value="series">This series ({series?.imageCount ?? 0} images)</option>
                <option value="study">Whole study ({study?.imageCount ?? 0} images, {study?.series.length ?? 0} series)</option>
              </select>
            </label>
            <Field label="Replace patient name with">{(f) => <Input {...f} value={pseudoName} onChange={(e) => setPseudoName(e.target.value)} />}</Field>
            <Field label="Replace patient ID with">{(f) => <Input {...f} value={pseudoId} onChange={(e) => setPseudoId(e.target.value)} />}</Field>
            <label className="col-span-2 flex items-center gap-2 text-secondary">
              <input type="checkbox" checked={keepDates} onChange={(e) => setKeepDates(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--accent))]" />
              Keep study and series dates (needed to compare priors)
            </label>
            <div className="col-span-2 rounded-lg border border-subtle bg-surface p-3 text-xs text-secondary">
              <p className="flex items-center gap-1.5 font-medium text-success">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> DICOM PS3.15 basic profile header scrub
              </p>
              <p className="mt-1">
                Removes names, IDs, birth date, addresses, physicians, institution and private tags; remaps study, series
                and instance UIDs consistently; keeps age and sex. Pixels are not inspected: text burned into the image
                (common on ultrasound and scanned documents) is not removed.
              </p>
            </div>
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
            <div className="h-1.5 overflow-hidden rounded-full bg-overlay">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(100 * busy.done) / Math.max(1, busy.total)}%` }} />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
