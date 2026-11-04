// Download a stored study as a ZIP of its (already anonymised) DICOM files.
// Streams: one instance is fetched from the archive, written, and released
// before the next. File names carry no patient text (there is none to carry).

import { listStudyInstances, retrieveInstance } from "./archive";
import { ZipWriter } from "./zipWriter";
import type { Study } from "./types";

export function zipFileName(study: Pick<Study, "title" | "id">): string {
  const base = study.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "study";
  return `${base}-${study.id}.zip`;
}

export function studyZipResponse(study: Study): Response {
  const zip = new ZipWriter();
  let instances: { series: string; sop: string }[] | null = null;
  let i = 0;
  const seriesIndex = new Map<string, number>();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        instances ??= await listStudyInstances(study.studyInstanceUID);
        if (i >= instances.length) {
          controller.enqueue(zip.finish());
          controller.close();
          return;
        }
        const { series, sop } = instances[i]!;
        i += 1;
        if (!seriesIndex.has(series)) seriesIndex.set(series, seriesIndex.size + 1);
        const bytes = await retrieveInstance(study.studyInstanceUID, series, sop);
        const name = `series-${String(seriesIndex.get(series)).padStart(3, "0")}/IM${String(i).padStart(5, "0")}.dcm`;
        for (const part of zip.file(name, bytes)) controller.enqueue(part);
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipFileName(study)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
