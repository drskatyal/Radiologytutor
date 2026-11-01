// Browser fallback for opening files (no Tauri): `npm run dev` in a normal
// browser and the Playwright smoke test. Delegates to the web viewer's own
// adapter (`lib/localDicomFiles.ts`) so the two paths cannot drift.

import { openLocalFiles } from "@flowrad/viewer-core";
import type { DesktopHeader } from "./types";

export async function headersFromBrowserFiles(
  files: File[],
  onProgress?: (read: number, accepted: number, total: number) => void
): Promise<DesktopHeader[]> {
  const result = await openLocalFiles(files, {
    onProgress: (p) => onProgress?.(p.read, p.accepted, p.total),
  });
  const out: DesktopHeader[] = [];
  let fileId = 0;
  for (const study of result.studies) {
    for (const series of study.series) {
      for (const instance of series.instances) {
        const ids = result.imageIdsByFile.get(instance.fileName);
        if (!ids?.length) continue;
        out.push({
          ...instance,
          fileId: fileId++,
          baseImageId: ids[0].replace(/\?frame=\d+$/, ""),
        });
      }
    }
  }
  return out;
}
