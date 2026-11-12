import { assertNoPhi, PhiError } from "./phiGuard";
/** Only coded modality and a numeric series number may label exported images. */
export function safeExportLabels(parts: { modality?: string | null; seriesNumber?: number | string | null }) {
  assertNoPhi(parts);
  const modality = parts.modality || "";
  const modalities = new Set(["CT", "MR", "PT", "NM", "US", "CR", "DX", "MG", "XA", "RF", "RG", "XC", "OT", "SM", "SEG", "SR", "PR", "KO", "ECG", "RTIMAGE", "RTDOSE", "RTPLAN", "RTSTRUCT", "SC"]);
  if (modality && !modalities.has(modality)) throw new PhiError();
  const seriesNumber = parts.seriesNumber == null || parts.seriesNumber === "" ? undefined : Number(parts.seriesNumber);
  if (seriesNumber !== undefined && (!Number.isInteger(seriesNumber) || seriesNumber < 0)) throw new PhiError();
  return { modality, seriesNumber };
}
export function safeExportLines(text: { anonymous: string[]; identifying?: string[] }): string[] {
  // Legacy callers cannot resurrect the former full identifying overlay.
  assertNoPhi({ PatientName: text.identifying ?? [] });
  assertNoPhi(text.anonymous);
  return [...text.anonymous];
}
