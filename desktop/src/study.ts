// Headers → studies → series the viewer can show.
//
// Grouping and slice ordering are `lib/localStudy.ts`, unchanged: a chest CT
// scrolls head-to-foot here for exactly the same reasons it does on the web.
// This module adds what the desktop needs on top: imageIds, patient/study
// details for the overlay and browser, cine rate, and whether a series is a
// clean volume (MPR / 3D / fusion eligible).

import {
  groupLocalStudies,
  imageIdsForInstance,
  instanceImageCount,
  sliceNormal,
} from "@/lib/localStudy";
import type { DesktopHeader, ViewerSeries, ViewerStudy } from "./types";

const MODALITY_ORDER = ["CT", "MR", "PT", "NM", "US", "XA", "RF", "CR", "DX", "MG", "SC", "OT"];

export function isVolumetric(headers: readonly DesktopHeader[]): boolean {
  if (headers.length < 3) return false;
  if (headers.some((h) => (h.numberOfFrames ?? 1) > 1)) return false;
  const first = headers[0];
  if (!first.imagePositionPatient || !first.imageOrientationPatient) return false;
  const orientation = first.imageOrientationPatient.join(",");
  if (headers.some((h) => h.imageOrientationPatient?.join(",") !== orientation)) return false;
  if (headers.some((h) => h.rows !== first.rows || h.columns !== first.columns)) return false;
  const normal = sliceNormal(first.imageOrientationPatient);
  if (!normal) return false;
  const positions = headers.map((h) => {
    const p = h.imagePositionPatient!;
    return p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2];
  });
  const gaps: number[] = [];
  for (let i = 1; i < positions.length; i += 1) gaps.push(Math.abs(positions[i] - positions[i - 1]));
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (!(mean > 1e-3)) return false;
  // Allow 10% jitter (rounded positions); reject gaps (scout + stack, missing slices).
  return gaps.every((g) => Math.abs(g - mean) <= Math.max(0.1 * mean, 0.01));
}

export function frameRateOf(header: DesktopHeader | undefined): number | undefined {
  if (!header) return undefined;
  if (header.recommendedDisplayFrameRate && header.recommendedDisplayFrameRate > 0) {
    return header.recommendedDisplayFrameRate;
  }
  if (header.frameTime && header.frameTime > 0) return Math.round(1000 / header.frameTime);
  return undefined;
}

/** "SMITH^JANE^^^" → "SMITH, JANE". */
export function formatPersonName(raw?: string): string {
  if (!raw) return "";
  const [family = "", given = "", middle = "", prefix = "", suffix = ""] = raw.split("^").map((s) => s.trim());
  const first = [prefix, given, middle].filter(Boolean).join(" ");
  const name = [family, first].filter(Boolean).join(", ");
  return [name, suffix].filter(Boolean).join(" ");
}

/** DICOM DA "20240131" → "2024-01-31". */
export function formatDicomDate(raw?: string): string {
  if (!raw) return "";
  const m = /^(\d{4})\.?(\d{2})\.?(\d{2})/.exec(raw.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : raw;
}

/** DICOM TM "142233.123" → "14:22". */
export function formatDicomTime(raw?: string): string {
  if (!raw) return "";
  const m = /^(\d{2}):?(\d{2})/.exec(raw.trim());
  return m ? `${m[1]}:${m[2]}` : "";
}

/**
 * PACS convention: an axial stack opens at the top of the patient. The shared
 * ordering (`sortSeriesInstances`) is ascending along the slice normal, which
 * for an axial series is feet-first; flip it when the slices are axial.
 */
export function headFirst(ordered: DesktopHeader[]): DesktopHeader[] {
  if (ordered.length < 2) return ordered;
  const first = ordered[0].imagePositionPatient;
  const last = ordered[ordered.length - 1].imagePositionPatient;
  const normal = sliceNormal(ordered[0].imageOrientationPatient);
  if (!first || !last || !normal || Math.abs(normal[2]) < 0.8) return ordered;
  return first[2] < last[2] ? [...ordered].reverse() : ordered;
}

export function buildStudies(headers: readonly DesktopHeader[]): ViewerStudy[] {
  const byFile = new Map(headers.map((h) => [h.fileName, h]));
  const grouped = groupLocalStudies(headers);
  return grouped.map((study) => {
    const series: ViewerSeries[] = study.series.map((s) => {
      const ordered = headFirst(s.instances.map((i) => byFile.get(i.fileName)!).filter(Boolean));
      const imageIds: string[] = [];
      const perImage: DesktopHeader[] = [];
      for (const h of ordered) {
        if (!h.baseImageId) continue;
        const ids = imageIdsForInstance(h.baseImageId, instanceImageCount(h));
        imageIds.push(...ids);
        for (let i = 0; i < ids.length; i += 1) perImage.push(h);
      }
      const first = ordered[0];
      return {
        uid: s.seriesInstanceUID,
        studyUid: s.studyInstanceUID,
        modality: (s.modality || "OT").toUpperCase(),
        number: s.seriesNumber,
        description: s.description?.trim() || first?.protocolName || "",
        imageIds,
        headers: perImage,
        imageCount: imageIds.length,
        frameRate: frameRateOf(first),
        multiframe: ordered.some((h) => (h.numberOfFrames ?? 1) > 1),
        frameOfReferenceUid: first?.frameOfReferenceUID,
        volumetric: isVolumetric(ordered),
      };
    });
    const first = series[0]?.headers[0];
    const modalities = [...new Set(series.map((s) => s.modality))].sort(
      (a, b) =>
        (MODALITY_ORDER.indexOf(a) + 1 || 99) - (MODALITY_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b)
    );
    return {
      uid: study.studyInstanceUID,
      description: study.description?.trim() || "",
      date: study.studyDate,
      time: first?.studyTime,
      accession: first?.accessionNumber,
      institution: first?.institutionName,
      patient: {
        name: first?.patientName,
        id: first?.patientId,
        sex: first?.patientSex,
        birthDate: first?.patientBirthDate,
        age: first?.patientAge,
        weight: first?.patientWeight,
      },
      modalities,
      series,
      imageCount: series.reduce((n, s) => n + s.imageCount, 0),
    };
  });
}

/** The series to put on screen first: the biggest cross-sectional stack. */
export function primarySeriesIndex(study: ViewerStudy): number {
  let best = 0;
  let bestScore = -1;
  study.series.forEach((s, i) => {
    const crossSectional = ["CT", "MR", "PT", "NM"].includes(s.modality) ? 2 : 1;
    const score = crossSectional * 1_000_000 + Math.min(s.imageCount, 999_999);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

export function describeSeries(s: ViewerSeries): string {
  return s.description || `${s.modality} series${s.number != null ? ` ${s.number}` : ""}`;
}
