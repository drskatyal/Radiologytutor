// Local persistence of image annotations (text boxes and measurements).
//
// Annotations are saved on this device only (desktop: the app data folder;
// web: IndexedDB), never in the DICOM files, which are opened read-only and
// never rewritten. A record is keyed by a hash of the Series Instance UID,
// so the store's file / key names carry no UID or patient text. The reader's
// own text is stored as typed; exports warn that it may identify a patient.
//
// This is NOT a DICOM Presentation State (GSPS): other viewers will not see
// these annotations. docs/RECON_AND_ANNOTATIONS.md explains the limits.

/**
 * FNV-1a, 64-bit, as 16 hex digits: a stable, non-cryptographic key for a UID
 * (the same function FlowRad Viewer's watched folders use for study keys), so
 * stored keys never carry the UID text itself.
 */
export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i += 1) {
    h ^= BigInt(text.charCodeAt(i) & 0xffff);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

export const ANNOTATION_SCHEMA = 1;
/** Longest text box (characters). */
export const MAX_ANNOTATION_TEXT = 500;
/** Most annotations kept per series. */
export const MAX_ANNOTATIONS_PER_SERIES = 2000;

export interface StoredAnnotation {
  id: string;
  tool: string;
  /** Image (slice / frame) index within the series. */
  imageIndex: number;
  /** Image pixel coordinates (column, row). */
  points: [number, number][];
  label?: string;
  /** SOP Instance UID hash of the image, to re-attach when the order changes. */
  imageKey?: string;
}

export interface AnnotationRecord {
  schema: number;
  seriesKey: string;
  savedAt: number;
  items: StoredAnnotation[];
}

export function seriesStorageKey(seriesInstanceUid: string): string {
  return fnv1a64(`series:${seriesInstanceUid}`);
}

export function imageStorageKey(sopInstanceUid: string, frame = 0): string {
  return fnv1a64(`image:${sopInstanceUid}:${frame}`);
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Validate untrusted stored JSON; drops anything malformed rather than failing the study. */
export function parseAnnotationRecord(raw: unknown, seriesKey: string): StoredAnnotation[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Partial<AnnotationRecord>;
  if (r.schema !== ANNOTATION_SCHEMA || r.seriesKey !== seriesKey || !Array.isArray(r.items)) return [];
  const out: StoredAnnotation[] = [];
  for (const it of r.items.slice(0, MAX_ANNOTATIONS_PER_SERIES)) {
    if (!it || typeof it !== "object") continue;
    const a = it as Partial<StoredAnnotation>;
    if (typeof a.id !== "string" || a.id.length > 64 || typeof a.tool !== "string" || a.tool.length > 40) continue;
    if (!Number.isInteger(a.imageIndex) || (a.imageIndex as number) < 0) continue;
    if (!Array.isArray(a.points) || a.points.length > 4096) continue;
    const points = a.points.filter((p): p is [number, number] => Array.isArray(p) && finite(p[0]) && finite(p[1])).map((p) => [p[0], p[1]] as [number, number]);
    if (points.length !== a.points.length || points.length === 0) continue;
    out.push({
      id: a.id,
      tool: a.tool,
      imageIndex: a.imageIndex as number,
      points,
      ...(typeof a.label === "string" ? { label: a.label.slice(0, MAX_ANNOTATION_TEXT) } : {}),
      ...(typeof a.imageKey === "string" && /^[0-9a-f]{16}$/.test(a.imageKey) ? { imageKey: a.imageKey } : {}),
    });
  }
  return out;
}

export function annotationRecord(seriesKey: string, items: readonly StoredAnnotation[], now = Date.now()): AnnotationRecord {
  return {
    schema: ANNOTATION_SCHEMA,
    seriesKey,
    savedAt: now,
    items: items.slice(0, MAX_ANNOTATIONS_PER_SERIES).map((a) => ({
      id: a.id,
      tool: a.tool,
      imageIndex: a.imageIndex,
      points: a.points.map((p) => [p[0], p[1]] as [number, number]),
      ...(a.label ? { label: a.label.slice(0, MAX_ANNOTATION_TEXT) } : {}),
      ...(a.imageKey ? { imageKey: a.imageKey } : {}),
    })),
  };
}

/**
 * Where a stored annotation goes now: by its image key when the series still
 * holds that image (order may differ between opens), else its saved index
 * when in range; null when neither fits (the image is gone).
 */
export function resolveImageIndex(a: StoredAnnotation, imageKeys: readonly string[]): number | null {
  if (a.imageKey) {
    const at = imageKeys.indexOf(a.imageKey);
    if (at >= 0) return at;
    if (imageKeys.length && imageKeys.some(Boolean)) return null;
  }
  return a.imageIndex < imageKeys.length || imageKeys.length === 0 ? a.imageIndex : null;
}

/** Text-box layout: the box's size in screen px for `text` (monospace-free estimate, wrapped). */
export function textBoxLines(text: string, maxChars = 36): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if ((line + " " + word).trim().length > maxChars && line) {
        lines.push(line);
        line = word;
      } else line = (line + " " + word).trim();
      while (line.length > maxChars) {
        lines.push(line.slice(0, maxChars));
        line = line.slice(maxChars);
      }
    }
    lines.push(line);
  }
  return lines.slice(0, 12);
}

/** Shown before any export that burns annotations or overlay text into pixels. */
export const BURNED_IN_WARNING =
  "Annotations and text are burned into the exported pixels. Text you typed (or an overlay) can identify the patient, and no DICOM anonymiser can remove it from the image afterwards. Check every exported image before sharing it.";
