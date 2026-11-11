/** Conservative identity checks, shared by server requests and browser exports.
 * This is not OCR or speech recognition; unchecked media requires human review.
 */
export class PhiError extends Error {
  readonly status = 422;
  constructor() { super("PHI review required: remove patient identifiers before continuing."); }
}
const identityKeys = /^(?:x?00100010|x?00100020|x?00100030|x?00080050|x?00080090|patientname|patientid|patientbirthdate|accession(?:number)?|referringphysician(?:name)?)$/i;
const placeholder = /^(?:|SYNTHETIC\^TEST|SYN-\d+|ANONYMOUS|ANONYMI[ZS]ED|REDACTED)$/i;
function values(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(values);
  if (value && typeof value === "object") return Object.entries(value).filter(([key]) => key !== "vr").flatMap(([, v]) => values(v));
  return value == null ? [] : [String(value)];
}
export function assertNoPhi(input: unknown): void {
  function visit(value: unknown): void {
    if (typeof value === "string") {
      if (/\b(?!SYNTHETIC\^TEST\b)[A-Z][A-Z'-]+\^[A-Z][A-Z'-]+\b/.test(value) ||
          /\b(?:patient\s*(?:name|id|birth\s*date)|accession(?:\s*number)?|referring\s*physician)\s*[:=]\s*(?!SYNTHETIC|SYN-|ANONYMOUS|REDACTED)\S/i.test(value)) throw new PhiError();
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      if (identityKeys.test(key.replace(/[\s_()-]/g, "")) && values(item).some(v => !placeholder.test(v.trim()))) throw new PhiError();
      visit(item);
    }
  }
  visit(input);
}
export function assertReviewedMedia(review: { pixels?: boolean; audio?: boolean; screen?: boolean } | undefined): void {
  if (!review?.pixels || !review.audio || !review.screen) throw new PhiError();
}
/** Export metadata is built from a fixed allowlist; identity never crosses this seam. */
export function exportSafeMetadata(input: Record<string, unknown>): Record<string, unknown> {
  assertNoPhi(input);
  const allowed = ["StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID", "SOPClassUID", "FrameOfReferenceUID", "Rows", "Columns", "PixelSpacing", "ImagePositionPatient", "ImageOrientationPatient", "NumberOfFrames", "Modality"];
  return Object.fromEntries(allowed.filter(key => key in input).map(key => [key, input[key]]));
}
