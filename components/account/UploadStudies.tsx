"use client";

// Store studies: pick a folder or files → headers read on this device →
// choose studies/series → anonymise each file IN THE BROWSER → upload the
// anonymised copy. The original files, names and UIDs never leave the device.
// Burned-in text in pixels is not detected; the reader confirms they checked.

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, FolderOpen, ShieldCheck, Upload } from "lucide-react";
import { parseDicom } from "dicom-parser";
import { Badge, Button, FilePickerButton, Input, Modal, ProgressBar, cn, useToast } from "@/components/ui";
import { anonymizeInstance } from "@/lib/cloud/anonymize";
import { api, errorText } from "@/lib/cloud/client";
import { defaultStudyTitle, newStudyRequest, planUpload, type PlannedStudy, type ScannedFile } from "@/lib/cloud/uploadPlan";
import type { Study } from "@/lib/cloud/types";

type Phase =
  | { kind: "pick" }
  | { kind: "scanning"; done: number; total: number }
  | { kind: "choose" }
  | { kind: "uploading"; done: number; total: number; label: string }
  | { kind: "done"; stored: number; failed: number };

const MAX_FILE_BYTES = 30 * 1024 * 1024;
const PARALLEL = 4;

async function readHeader(file: File, index: number): Promise<ScannedFile | null> {
  if (file.size < 132 || file.size > MAX_FILE_BYTES) return null;
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 512 * 1024)).arrayBuffer());
  if (String.fromCharCode(head[128]!, head[129]!, head[130]!, head[131]!) !== "DICM") return null;
  try {
    const ds = parseDicom(head, { untilTag: "x7fe00010" });
    const studyUid = ds.string("x0020000d");
    const seriesUid = ds.string("x0020000e");
    if (!studyUid || !seriesUid) return null;
    const sn = ds.intString("x00200011");
    return {
      index,
      bytes: file.size,
      studyUid,
      seriesUid,
      modality: ds.string("x00080060") || undefined,
      seriesDescription: ds.string("x0008103e") || undefined,
      seriesNumber: Number.isFinite(sn) ? sn : undefined,
      studyDescription: ds.string("x00081030") || undefined,
    };
  } catch {
    return null;
  }
}

function fmtBytes(n: number): string {
  return n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
}

export function UploadStudies({ remaining }: { remaining: number }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [plan, setPlan] = useState<PlannedStudy[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [removeDates, setRemoveDates] = useState(true);
  const [checkedPixels, setCheckedPixels] = useState(false);
  const [skipped, setSkipped] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const files = useRef<File[]>([]);
  const router = useRouter();
  const { toast } = useToast();

  const reset = () => {
    setPhase({ kind: "pick" });
    setPlan([]);
    setSelected(new Set());
    setTitles({});
    setCheckedPixels(false);
    setSkipped(0);
    setErrors([]);
    files.current = [];
  };

  const onFiles = useCallback(async (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    files.current = picked;
    setPhase({ kind: "scanning", done: 0, total: picked.length });
    const scanned: ScannedFile[] = [];
    for (let i = 0; i < picked.length; i++) {
      const s = await readHeader(picked[i]!, i);
      if (s) scanned.push(s);
      if (i % 20 === 0 || i === picked.length - 1) setPhase({ kind: "scanning", done: i + 1, total: picked.length });
    }
    const studies = planUpload(scanned);
    setSkipped(picked.length - scanned.length);
    setPlan(studies);
    setSelected(new Set(studies.flatMap((st) => st.series.filter((s) => s.defaultSelected).map((s) => s.seriesUid))));
    setTitles(Object.fromEntries(studies.map((st) => [st.studyUid, defaultStudyTitle(st)])));
    setPhase({ kind: "choose" });
  }, []);

  const chosenStudies = useMemo(() => plan.filter((st) => st.series.some((s) => selected.has(s.seriesUid))), [plan, selected]);
  const chosenFiles = useMemo(
    () => chosenStudies.reduce((n, st) => n + st.series.filter((s) => selected.has(s.seriesUid)).reduce((m, s) => m + s.fileIndexes.length, 0), 0),
    [chosenStudies, selected]
  );
  const overQuota = chosenStudies.length > remaining;

  const upload = async () => {
    setErrors([]);
    let me: { uidSalt: string };
    try {
      me = await api<{ uidSalt: string }>("/api/me");
    } catch (err) {
      setErrors([errorText(err)]);
      return;
    }
    let stored = 0;
    let failed = 0;
    let done = 0;
    const problems: string[] = [];
    for (const st of chosenStudies) {
      const title = titles[st.studyUid]?.trim() || defaultStudyTitle(st);
      let study: Study;
      try {
        study = (await api<{ study: Study }>("/api/studies", { method: "POST", json: newStudyRequest(st, selected, me.uidSalt, title) })).study;
      } catch (err) {
        problems.push(`${title}: ${errorText(err)}`);
        failed += 1;
        continue;
      }
      const indexes = st.series.filter((s) => selected.has(s.seriesUid)).flatMap((s) => s.fileIndexes);
      let fileErrors = 0;
      let next = 0;
      const worker = async () => {
        while (next < indexes.length) {
          const file = files.current[indexes[next++]!]!;
          try {
            const anon = anonymizeInstance(new Uint8Array(await file.arrayBuffer()), { uidSalt: me.uidSalt, removeDates });
            const res = await fetch(`/api/studies/${study.id}/instances`, {
              method: "POST",
              headers: { "Content-Type": "application/dicom" },
              body: anon.bytes as BodyInit,
            });
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              throw new Error(body.error || `Upload failed (${res.status})`);
            }
          } catch (err) {
            fileErrors += 1;
            if (problems.length < 8) problems.push(`${file.name}: ${errorText(err)}`);
          }
          done += 1;
          setPhase({ kind: "uploading", done, total: chosenFiles, label: title });
        }
      };
      setPhase({ kind: "uploading", done, total: chosenFiles, label: title });
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      try {
        await api(`/api/studies/${study.id}/complete`, { method: "POST" });
        stored += 1;
        if (fileErrors) problems.push(`${title}: ${fileErrors} image(s) could not be stored.`);
      } catch (err) {
        failed += 1;
        problems.push(`${title}: ${errorText(err)}`);
      }
    }
    setErrors(problems);
    setPhase({ kind: "done", stored, failed });
    router.refresh();
    toast({
      title: stored ? `${stored} ${stored === 1 ? "study" : "studies"} stored` : "Nothing was stored",
      description: failed ? `${failed} could not be stored. See the details.` : "Anonymised in your browser before upload.",
      variant: stored && !failed ? "success" : failed ? "warning" : "default",
    });
  };

  const busy = phase.kind === "scanning" || phase.kind === "uploading";

  return (
    <>
      <Button leadingIcon={<Upload className="h-4 w-4" aria-hidden />} onClick={() => setOpen(true)} data-testid="store-studies">
        Store studies
      </Button>
      <Modal
        open={open}
        onClose={() => {
          if (busy) return;
          setOpen(false);
          reset();
        }}
        size="xl"
        title="Store studies"
        description="Files are anonymised on this device. Only the anonymised copy is uploaded."
        footer={
          phase.kind === "choose" ? (
            <>
              <Button variant="ghost" onClick={reset}>
                Choose other files
              </Button>
              <Button
                onClick={upload}
                disabled={!chosenStudies.length || !checkedPixels || overQuota}
                leadingIcon={<ShieldCheck className="h-4 w-4" aria-hidden />}
                data-testid="anonymise-upload"
              >
                Anonymise and store {chosenStudies.length || ""} {chosenStudies.length === 1 ? "study" : "studies"}
              </Button>
            </>
          ) : phase.kind === "done" ? (
            <Button
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              Done
            </Button>
          ) : null
        }
      >
        {phase.kind === "pick" && (
          <div className="flex flex-col items-start gap-4">
            <p className="text-sm text-secondary">
              Choose a study folder (a CD, USB stick or PACS export) or individual DICOM files. ZIP files: unzip them first.
            </p>
            <div className="flex flex-wrap gap-3">
              <input
                id="upload-folder"
                type="file"
                className="sr-only"
                // @ts-expect-error non-standard but supported by every current browser
                webkitdirectory=""
                multiple
                onChange={(e) => void onFiles(e.target.files)}
              />
              <input id="upload-files" type="file" className="sr-only" multiple onChange={(e) => void onFiles(e.target.files)} />
              <FilePickerButton inputId="upload-folder" leadingIcon={<FolderOpen />}>
                Choose a folder
              </FilePickerButton>
              <FilePickerButton inputId="upload-files" variant="secondary">
                Choose files
              </FilePickerButton>
            </div>
            <p className="text-xs text-muted">You can store {remaining} more {remaining === 1 ? "study" : "studies"} on your plan.</p>
          </div>
        )}

        {phase.kind === "scanning" && (
          <div role="status" className="space-y-3">
            <p className="text-sm">Reading headers on this device…</p>
            <ProgressBar value={phase.done / phase.total} label="Reading files" valueText={`${phase.done} of ${phase.total} files`} />
          </div>
        )}

        {phase.kind === "choose" && (
          <div className="space-y-5">
            {!plan.length ? (
              <p role="alert" className="text-sm text-danger">
                None of those files are DICOM images FlowRad Viewer can store. Choose the folder that holds the images.
              </p>
            ) : (
              plan.map((st) => (
                <fieldset key={st.studyUid} className="rounded-xl border border-subtle p-4">
                  <legend className="sr-only">Study</legend>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted" htmlFor={`title-${st.studyUid}`}>
                    Title
                  </label>
                  <Input
                    id={`title-${st.studyUid}`}
                    className="mt-1"
                    maxLength={200}
                    value={titles[st.studyUid] ?? ""}
                    onChange={(e) => setTitles((t) => ({ ...t, [st.studyUid]: e.target.value }))}
                  />
                  <ul className="mt-3 divide-y divide-subtle">
                    {st.series.map((s) => (
                      <li key={s.seriesUid} className="flex items-center gap-3 py-2">
                        <input
                          id={`s-${s.seriesUid}`}
                          type="checkbox"
                          className="h-4 w-4 accent-[rgb(var(--accent))]"
                          checked={selected.has(s.seriesUid)}
                          onChange={(e) =>
                            setSelected((prev) => {
                              const n = new Set(prev);
                              if (e.target.checked) n.add(s.seriesUid);
                              else n.delete(s.seriesUid);
                              return n;
                            })
                          }
                        />
                        <label htmlFor={`s-${s.seriesUid}`} className="min-w-0 flex-1 text-sm">
                          <span className="font-medium">
                            {s.modality ?? "—"} {s.description ?? `Series ${s.seriesNumber ?? ""}`}
                          </span>
                          {s.caution && <span className="block text-xs text-warning">{s.caution}</span>}
                        </label>
                        <span className="text-xs tabular-nums text-muted">
                          {s.fileIndexes.length} img · {fmtBytes(s.bytes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              ))
            )}
            {skipped > 0 && <p className="text-xs text-muted">{skipped} file(s) were not DICOM images (or were over 30 MB) and will be skipped.</p>}
            <div className="space-y-3 rounded-xl bg-overlay/60 p-4 text-sm">
              <p className="font-semibold">Removed on this device before upload</p>
              <p className="text-secondary">
                Patient name, ID, birth date and address; physicians, operators and institution; accession and study IDs;
                private tags. UIDs are replaced. Age and sex are kept.
              </p>
              <label className="flex items-start gap-3">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]" checked={removeDates} onChange={(e) => setRemoveDates(e.target.checked)} />
                <span>Also remove study and series dates</span>
              </label>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]"
                  checked={checkedPixels}
                  onChange={(e) => setCheckedPixels(e.target.checked)}
                  data-testid="confirm-pixels"
                />
                <span>
                  I have checked that these images show no patient details burned into the pixels (names on scout views,
                  screen captures, scanned forms). <span className="text-secondary">Pixels are not inspected automatically.</span>
                </span>
              </label>
            </div>
            {overQuota && (
              <p role="alert" className="text-sm text-danger">
                Your plan has room for {remaining} more {remaining === 1 ? "study" : "studies"}. Untick some, or delete stored studies first.
              </p>
            )}
            {errors.length > 0 && (
              <ul role="alert" className="list-disc pl-5 text-sm text-danger">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {phase.kind === "uploading" && (
          <div role="status" className="space-y-3">
            <p className="text-sm">
              Anonymising and storing <span className="font-semibold">{phase.label}</span>…
            </p>
            <ProgressBar value={phase.total ? phase.done / phase.total : null} label="Storing" valueText={`${phase.done} of ${phase.total} images`} />
            <p className="text-xs text-muted">Keep this tab open until it finishes.</p>
          </div>
        )}

        {phase.kind === "done" && (
          <div className="space-y-3">
            <p className={cn("flex items-center gap-2 text-sm font-semibold", phase.failed ? "text-warning" : "text-success")}>
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              {phase.stored} stored{phase.failed ? `, ${phase.failed} failed` : ""}
            </p>
            {errors.length > 0 && (
              <ul className="list-disc pl-5 text-sm text-secondary">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            <Badge variant="accent">Add the history, findings and diagnosis on each study page.</Badge>
          </div>
        )}
      </Modal>
    </>
  );
}
