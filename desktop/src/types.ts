// Wire types from the Rust shell (desktop/src-tauri/src/header.rs, scan.rs)
// and the renderer's study model.

import type { LocalInstanceHeader } from "@flowrad/viewer-core";

/** `Header` in header.rs — a superset of `LocalInstanceHeader`. */
export interface DesktopHeader extends LocalInstanceHeader {
  fileId: number;
  mtime?: number;
  sopClassUID?: string;
  transferSyntaxUID?: string;
  pixelSpacing?: number[];
  sliceThickness?: number;
  sliceLocation?: number;
  seriesDate?: string;
  seriesTime?: string;
  studyTime?: string;
  accessionNumber?: string;
  bodyPartExamined?: string;
  protocolName?: string;
  manufacturer?: string;
  manufacturerModelName?: string;
  institutionName?: string;
  bitsAllocated?: number;
  photometricInterpretation?: string;
  windowCenter?: number;
  windowWidth?: number;
  frameTime?: number;
  recommendedDisplayFrameRate?: number;
  imageType?: string;
  frameOfReferenceUID?: string;
  patientName?: string;
  patientId?: string;
  patientBirthDate?: string;
  patientSex?: string;
  patientAge?: string;
  patientWeight?: number;
  referringPhysicianName?: string;
  /** Renderer-side: the Cornerstone imageId of frame 1. */
  baseImageId?: string;
}

export interface ScanProgress {
  phase: "listing" | "reading";
  read: number;
  accepted: number;
  total: number;
}

export type SourceKind = "folder" | "dicomdir" | "zip" | "files" | "disc";

export interface ScanResult {
  headers: DesktopHeader[];
  kind: SourceKind;
  label: string;
  inspected: number;
  skipped: number;
  cacheHits: number;
  usedDicomdir: boolean;
  warnings: string[];
  timings: { listMs: number; parseMs: number; totalMs: number };
}

export interface PatientInfo {
  name?: string;
  id?: string;
  sex?: string;
  birthDate?: string;
  age?: string;
  weight?: number;
}

export interface ViewerSeries {
  uid: string;
  studyUid: string;
  modality: string;
  number?: number;
  description: string;
  /** Ordered stack (frames expanded). */
  imageIds: string[];
  /** Header for each imageId (a multiframe header repeats per frame). */
  headers: DesktopHeader[];
  imageCount: number;
  /** Cine default from the DICOM frame rate, when present. */
  frameRate?: number;
  multiframe: boolean;
  frameOfReferenceUid?: string;
  /** True when the slices are parallel and evenly spaced (MPR/3D eligible). */
  volumetric: boolean;
}

export interface ViewerStudy {
  uid: string;
  description: string;
  date?: string;
  time?: string;
  accession?: string;
  institution?: string;
  patient: PatientInfo;
  modalities: string[];
  series: ViewerSeries[];
  imageCount: number;
}

export interface OpenedSource {
  /** History key: the sorted, joined source paths. */
  key: string;
  paths: string[];
  kind: SourceKind;
  label: string;
}
