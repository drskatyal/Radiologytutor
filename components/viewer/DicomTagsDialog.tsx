"use client";

// DICOM tags of the image on screen (or a series' first image: "Series
// info"), desktop and web. Reads the header the image loader already parsed
// for that image (dicom-parser dataset in its cache), so opening it costs no
// file read. Searchable; patient-identifying values masked when the app hides
// patient details.

import { useEffect, useMemo, useState } from "react";
import { EmptyState, Modal, Spinner } from "@/components/ui";
import { Input } from "@/components/ui/Input";
import { filterTagRows, tagRows, type DicomTagRow, type TagDataSet } from "@flowrad/viewer-core";

/* eslint-disable @typescript-eslint/no-explicit-any -- the loader module is untyped here. */

/** The parsed header for an imageId from the dicom-image-loader cache (wadouri / dicomfile). */
export async function dataSetFor(imageId: string): Promise<TagDataSet | null> {
  const mod: any = await import("@cornerstonejs/dicom-image-loader");
  const loader = mod.default ?? mod;
  const cache = loader?.wadouri?.dataSetCacheManager;
  if (!cache) return null;
  const noFrame = imageId.replace(/[?&]frame=\d+$/, "");
  const candidates = [noFrame.replace(/^wadouri:/, ""), noFrame, noFrame.replace(/^dicomfile:/, "")];
  for (const uri of candidates) {
    const ds = cache.get?.(uri);
    if (ds?.elements) return ds as TagDataSet;
  }
  // Not cached yet (never shown): load it (a header read for local files).
  try {
    const uri = candidates[0];
    const ds = await cache.load(uri, loader.wadouri.loadFileRequest ?? undefined, imageId);
    return ds?.elements ? (ds as TagDataSet) : null;
  } catch {
    return null;
  }
}

export interface DicomTagsDialogProps {
  open: boolean;
  onClose: () => void;
  imageId: string | null;
  title?: string;
  /** e.g. "CT · Se 2 · Axial 1.0mm · image 31 of 300". */
  description?: string;
  hidePatient?: boolean;
  /** Summary rows shown above the tag list (Series info). */
  summary?: { label: string; value: string }[];
}

export function DicomTagsDialog({ open, onClose, imageId, title = "DICOM tags", description, hidePatient = false, summary }: DicomTagsDialogProps) {
  const [rows, setRows] = useState<DicomTagRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open || !imageId) return;
    let alive = true;
    setRows(null);
    setFailed(false);
    void dataSetFor(imageId).then(
      (ds) => {
        if (!alive) return;
        if (!ds) setFailed(true);
        else setRows(tagRows(ds, { hideIdentifying: hidePatient }));
      },
      () => alive && setFailed(true)
    );
    return () => {
      alive = false;
    };
  }, [open, imageId, hidePatient]);

  const shown = useMemo(() => (rows ? filterTagRows(rows, query) : []), [rows, query]);

  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size="2xl">
      <div className="flex flex-col gap-3" data-testid="dicom-tags">
        {summary?.length ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-lg border border-subtle bg-surface p-3 text-sm">
            {summary.map((s) => (
              <div key={s.label} className="contents">
                <dt className="text-muted">{s.label}</dt>
                <dd className="tabular-nums text-primary">{s.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <Input
          type="search"
          placeholder="Search tag, name or value (e.g. 0028,0030 or thickness)"
          aria-label="Search tags"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        {failed ? (
          <EmptyState title="Tags not available" description="This image's header could not be read here." />
        ) : !rows ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-secondary">
            <Spinner size="sm" label="Reading tags" /> Reading tags…
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-auto rounded-lg border border-subtle">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-elevated text-left text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Tag</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 font-medium">VR</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.tag} className="border-t border-subtle align-top">
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums text-secondary">{r.tag}</td>
                    <td className="px-3 py-1.5 text-primary">{r.name}</td>
                    <td className="px-2 py-1.5 font-mono text-muted">{r.vr}</td>
                    <td className="break-all px-3 py-1.5 tabular-nums text-primary">{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!shown.length && <p className="p-4 text-center text-sm text-muted">No tag matches “{query}”.</p>}
          </div>
        )}
        {rows && (
          <p className="text-xs text-muted tabular-nums">
            {shown.length} of {rows.length} elements{hidePatient ? " · patient details hidden" : ""}
          </p>
        )}
      </div>
    </Modal>
  );
}
