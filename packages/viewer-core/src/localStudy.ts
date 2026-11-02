// Opening DICOM off the local disk: recognising it, grouping it, ordering it.
//
// This is the shared core of the free standalone viewer in `docs/DESKTOP_PLAN.md`.
// A radiologist with a CD, a USB stick, or a folder from a colleague does not
// have a DICOMweb archive — they have a directory of files, usually with no
// extension (`IM000001`, `I10`, `0001`), often with a `DICOMDIR` index, and
// often with junk alongside (an autorun stub, a bundled Windows viewer,
// `.DS_Store`). Nothing may be uploaded anywhere: the whole point is that the
// study never leaves the machine.
//
// Pure functions over header records. The browser/Tauri adapter that reads the
// bytes and parses the headers is `lib/localDicomFiles.ts`; keeping the
// grouping here means the ordering rules — the part that decides whether a
// chest CT scrolls head-to-foot or in filename order — are unit-tested and
// identical on web and desktop.
//
// Ordering, in the order PACS vendors apply it:
//   1. Along the slice normal (ImagePositionPatient · normal). This is the
//      only ordering that is anatomically correct, and it is what makes MPR
//      and "scroll down the chest" mean the same thing on every study.
//   2. InstanceNumber, when positions are missing or degenerate.
//   3. File name, natural-sorted, as the last resort — `IM10` must not sort
//      before `IM9`.

/** DICOM Part 10 files carry "DICM" at byte offset 128. */
export const DICM_PREAMBLE_OFFSET = 128;

export interface LocalInstanceHeader {
  /** Path as the user sees it, e.g. `DICOM/ST0/SE1/IM000042`. */
  fileName: string;
  sizeBytes: number;
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
  instanceNumber?: number;
  imagePositionPatient?: readonly number[];
  imageOrientationPatient?: readonly number[];
  modality?: string;
  seriesNumber?: number;
  seriesDescription?: string;
  studyDescription?: string;
  studyDate?: string;
  /** Multiframe instances (a cine loop, an enhanced CT) hold many images. */
  numberOfFrames?: number;
  rows?: number;
  columns?: number;
  /** (0002,0010). Decides which decoder (and WASM codec) a frame needs. */
  transferSyntaxUID?: string;
}

export interface LocalSeries {
  seriesInstanceUID: string;
  studyInstanceUID: string;
  modality?: string;
  seriesNumber?: number;
  description?: string;
  /** Ordered by the rules in the module header. */
  instances: LocalInstanceHeader[];
  /** Images, counting every frame of a multiframe instance. */
  imageCount: number;
}

export interface LocalStudy {
  studyInstanceUID: string;
  description?: string;
  studyDate?: string;
  /** Finding-irrelevant here: ordered by series number, then UID. */
  series: LocalSeries[];
  imageCount: number;
}

/**
 * Does this look like a DICOM Part 10 file? Checks the "DICM" magic at the
 * standard offset, and also at offset 0 for the (non-conformant but common)
 * preamble-less files some modalities and anonymisers write.
 *
 * Extension is deliberately NOT consulted: most media write `IM000001`.
 */
export function hasDicomMagic(bytes: Uint8Array): boolean {
  const matches = (at: number) =>
    bytes.length >= at + 4 &&
    bytes[at] === 0x44 && // D
    bytes[at + 1] === 0x49 && // I
    bytes[at + 2] === 0x43 && // C
    bytes[at + 3] === 0x4d; // M
  return matches(DICM_PREAMBLE_OFFSET) || matches(0);
}

/** The DICOMDIR index at the root of a DICOM CD. An index, not an image. */
export function isDicomDir(fileName: string): boolean {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.toUpperCase() === "DICOMDIR";
}

/**
 * Files that are never DICOM and should not even be read. Saves opening every
 * JPEG of a bundled vendor viewer on a 700 MB CD.
 */
export function isObviouslyNotDicom(fileName: string): boolean {
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).toLowerCase();
  if (base.startsWith(".")) return true; // .DS_Store, .Trashes
  if (base === "autorun.inf" || base === "thumbs.db" || base === "desktop.ini") return true;
  return /\.(exe|dll|ini|inf|txt|pdf|html?|js|css|jpe?g|png|gif|bmp|zip|rar|7z|xml|cab|msi|dylib|so)$/.test(
    base
  );
}

// One collator for every comparison: `localeCompare` with options builds a
// new collator per call, which made sorting a 2 000-file CD cost ~100 ms.
let naturalCollator: Intl.Collator | null = null;

/** Natural compare so `IM9` sorts before `IM10`. */
export function compareFileNames(a: string, b: string): number {
  naturalCollator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return naturalCollator.compare(a, b);
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function finiteTriple(values: readonly number[] | undefined): [number, number, number] | null {
  if (!values || values.length < 3) return null;
  const [x, y, z] = values;
  if (![x, y, z].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return [x, y, z];
}

/**
 * Slice normal from ImageOrientationPatient (row cosines × column cosines).
 * Null when the series has no usable orientation — which is exactly when
 * three-plane MPR must refuse, so the same signal drives both.
 */
export function sliceNormal(
  orientation: readonly number[] | undefined
): [number, number, number] | null {
  if (!orientation || orientation.length < 6) return null;
  const row = finiteTriple(orientation.slice(0, 3));
  const column = finiteTriple(orientation.slice(3, 6));
  if (!row || !column) return null;
  const normal = cross(row, column);
  const length = Math.hypot(...normal);
  if (!Number.isFinite(length) || length < 1e-6) return null;
  // `+ 0` folds -0 into 0: a cross product of axis-aligned cosines produces
  // negative zeros, and a -0 component reads as a sign flip to a caller.
  return [normal[0] / length + 0, normal[1] / length + 0, normal[2] / length + 0];
}

/** Signed distance of an instance along the slice normal, or null. */
export function slicePosition(instance: LocalInstanceHeader): number | null {
  const normal = sliceNormal(instance.imageOrientationPatient);
  const position = finiteTriple(instance.imagePositionPatient);
  if (!normal || !position) return null;
  return normal[0] * position[0] + normal[1] * position[1] + normal[2] * position[2];
}

/**
 * Order one series' instances. Uses slice position when EVERY instance has one
 * and they are not all equal (a degenerate set — e.g. a localiser repeated at
 * one position — must fall through to InstanceNumber rather than scramble).
 */
export function sortSeriesInstances(
  instances: readonly LocalInstanceHeader[]
): LocalInstanceHeader[] {
  const positions = instances.map(slicePosition);
  const everyPositioned = positions.every((value) => value != null);
  const distinct = new Set(positions.filter((value): value is number => value != null));
  const byPosition = everyPositioned && distinct.size > 1;

  return instances
    .map((instance, index) => ({ instance, index, position: positions[index] }))
    .sort((a, b) => {
      if (byPosition && a.position != null && b.position != null && a.position !== b.position) {
        return a.position - b.position;
      }
      const an = a.instance.instanceNumber;
      const bn = b.instance.instanceNumber;
      if (an != null && bn != null && an !== bn) return an - bn;
      if (an != null && bn == null) return -1;
      if (an == null && bn != null) return 1;
      return compareFileNames(a.instance.fileName, b.instance.fileName);
    })
    .map((entry) => entry.instance);
}

/** Images this instance contributes. A multiframe cine is many. */
export function instanceImageCount(instance: LocalInstanceHeader): number {
  const frames = instance.numberOfFrames;
  if (frames == null || !Number.isFinite(frames) || frames < 1) return 1;
  return Math.round(frames);
}

/**
 * Group parsed headers into studies → series → ordered instances.
 *
 * Files with no SeriesInstanceUID are not dropped: a study whose headers are
 * partly unreadable is still worth opening, so they collect under a synthetic
 * series keyed by their folder. Anything with no StudyInstanceUID collects
 * under one synthetic study, which is what a user who dragged in a flat
 * directory of loose images expects to see.
 */
export function groupLocalStudies(
  headers: readonly LocalInstanceHeader[]
): LocalStudy[] {
  const studies = new Map<string, LocalStudy>();
  // Series by study + UID: a linear find per header was ~1.2M compares for a
  // 10,310-image MRI (242 series) and showed up as a 60 ms freeze per rebuild.
  const seriesIndex = new Map<string, LocalStudy["series"][number]>();

  for (const header of headers) {
    const studyUid = header.studyInstanceUID?.trim() || "local.unknown.study";
    const seriesUid =
      header.seriesInstanceUID?.trim() ||
      `local.unknown.series:${header.fileName.split(/[\\/]/).slice(0, -1).join("/") || "root"}`;

    let study = studies.get(studyUid);
    if (!study) {
      study = {
        studyInstanceUID: studyUid,
        description: header.studyDescription,
        studyDate: header.studyDate,
        series: [],
        imageCount: 0,
      };
      studies.set(studyUid, study);
    }
    study.description ||= header.studyDescription;
    study.studyDate ||= header.studyDate;

    const seriesKey = `${studyUid}\u0000${seriesUid}`;
    let series = seriesIndex.get(seriesKey);
    if (!series) {
      series = {
        seriesInstanceUID: seriesUid,
        studyInstanceUID: studyUid,
        modality: header.modality,
        seriesNumber: header.seriesNumber,
        description: header.seriesDescription,
        instances: [],
        imageCount: 0,
      };
      study.series.push(series);
      seriesIndex.set(seriesKey, series);
    }
    series.modality ||= header.modality;
    series.description ||= header.seriesDescription;
    if (series.seriesNumber == null) series.seriesNumber = header.seriesNumber;
    series.instances.push(header);
  }

  for (const study of studies.values()) {
    for (const series of study.series) {
      series.instances = sortSeriesInstances(series.instances);
      series.imageCount = series.instances.reduce(
        (total, instance) => total + instanceImageCount(instance),
        0
      );
    }
    study.series.sort(
      (a, b) =>
        (a.seriesNumber ?? Number.MAX_SAFE_INTEGER) -
          (b.seriesNumber ?? Number.MAX_SAFE_INTEGER) ||
        compareFileNames(a.seriesInstanceUID, b.seriesInstanceUID)
    );
    study.imageCount = study.series.reduce((total, series) => total + series.imageCount, 0);
  }

  return [...studies.values()].sort(
    (a, b) =>
      (b.studyDate ?? "").localeCompare(a.studyDate ?? "") ||
      compareFileNames(a.studyInstanceUID, b.studyInstanceUID)
  );
}

/**
 * Cornerstone imageIds for one instance, one per frame.
 *
 * Lives here rather than beside the file reader so it can be unit-tested
 * without the browser-only loader: an off-by-one makes a cine loop start on
 * the second frame and drop the last one. The `wadouri` loader reads
 * `?frame=` 1-based and subtracts one internally.
 */
export function imageIdsForInstance(baseImageId: string, frames: number): string[] {
  if (!Number.isFinite(frames) || frames <= 1) return [baseImageId];
  return Array.from(
    { length: Math.round(frames) },
    (_, index) => `${baseImageId}?frame=${index + 1}`
  );
}

/** One line for the series rail: "CT · 240 images · Chest w/o contrast". */
export function describeLocalSeries(series: LocalSeries): string {
  const parts = [series.modality?.trim() || "DICOM"];
  parts.push(`${series.imageCount} image${series.imageCount === 1 ? "" : "s"}`);
  const description = series.description?.trim();
  if (description) parts.push(description);
  return parts.join(" · ");
}
