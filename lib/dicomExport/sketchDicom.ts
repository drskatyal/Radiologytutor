/**
 * Teacher sketches → DICOM.
 *
 *   • DICOM SR, Comprehensive 3D SR, TID 1500 "Measurement Report". One
 *     TID 1410 planar-ROI measurement group per stroke / marker, each with a
 *     SCOORD (image pixels, SELECTED FROM the exact SOP + frame) and, when
 *     the image plane and Frame of Reference are known, a SCOORD3D in patient
 *     mm. OHIF's dicom-sr extension lists the groups and draws the SCOORDs.
 *   • GSPS (Grayscale Softcopy Presentation State): the same ink as graphic
 *     objects + text on a "FLOWRAD_SKETCH" layer, for PACS that show GSPS.
 *
 * Coordinates: our pixel index has pixel centres on integers; SR SCOORD and
 * GSPS PIXEL units put 0\0 at the top-left corner of the first pixel, so the
 * exporter adds 0.5 (`indexToScoord`) and the reader subtracts it.
 *
 * Patient / study attributes are copied from a referenced instance (the
 * caller reads one from the archive) so the SR files under the same study.
 * Studies are de-identified at ingest; nothing here invents identifiers.
 *
 * Pure apart from dcmjs serialisation. No network.
 */

import dcmjs from "dcmjs";
import {
  fractionToIndex,
  indexToPatient,
  indexToScoord,
  scoordToIndex,
  type DicomImagePlane,
} from "../sketchProjection";
import type { SketchImagePoint, TeacherSketchItem } from "../types";

export const SOP_CLASS = {
  comprehensive3dSr: "1.2.840.10008.5.1.4.1.1.88.34",
  gsps: "1.2.840.10008.5.1.4.1.1.11.1",
  ctImage: "1.2.840.10008.5.1.4.1.1.2",
} as const;

const EXPLICIT_VR_LE = "1.2.840.10008.1.2.1";
const IMPLEMENTATION_UID = "2.25.270915112440126203947012236095846081473";
const SCHEME = "99FLOWRAD";
export const TRACKING_PREFIX = "FlowRadSketch";

type Dataset = Record<string, unknown>;

/** Patient / study / referenced-image context, read from an archive instance. */
export interface SketchExportContext {
  studyInstanceUID: string;
  patientName?: string;
  patientID?: string;
  patientBirthDate?: string;
  patientSex?: string;
  studyDate?: string;
  studyTime?: string;
  studyID?: string;
  accessionNumber?: string;
  referringPhysicianName?: string;
  /** SOP Class of referenced images when the items do not carry it. */
  sopClassUID?: string;
  frameOfReferenceUID?: string;
  /** Observer shown in the SR (the teacher). */
  observerName?: string;
  /** Pixel grid fallback when items predate stored columns/rows. */
  columns?: number;
  rows?: number;
}

export interface SketchExportResult {
  bytes: ArrayBuffer;
  sopInstanceUID: string;
  seriesInstanceUID: string;
  /** Items written, by id → tracking UID (SR) or graphic count (GSPS). */
  written: string[];
  /** Items that could not be placed (no SOP UID or no pixel grid). */
  skipped: { id: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// UIDs / dates
// ---------------------------------------------------------------------------

/** A 2.25 UUID-derived UID (PS3.5 B.2). */
export function newUid(): string {
  const hex = globalThis.crypto.randomUUID().replace(/-/g, "");
  return `2.25.${BigInt(`0x${hex}`).toString(10)}`;
}

function dicomDate(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

function dicomTime(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

function code(value: string, scheme: string, meaning: string): Dataset {
  return { CodeValue: value, CodingSchemeDesignator: scheme, CodeMeaning: meaning.slice(0, 64) };
}

const CODES = {
  report: code("126000", "DCM", "Imaging Measurement Report"),
  language: code("121049", "DCM", "Language of Content Item and Descendants"),
  english: code("eng", "RFC5646", "English"),
  observerType: code("121005", "DCM", "Observer Type"),
  person: code("121006", "DCM", "Person"),
  personName: code("121008", "DCM", "Person Observer Name"),
  procedure: code("121058", "DCM", "Procedure reported"),
  imagingProcedure: code("363679005", "SCT", "Imaging procedure"),
  imageLibrary: code("111028", "DCM", "Image Library"),
  imageLibraryGroup: code("126200", "DCM", "Image Library Group"),
  measurements: code("126010", "DCM", "Imaging Measurements"),
  group: code("125007", "DCM", "Measurement Group"),
  trackingId: code("112039", "DCM", "Tracking Identifier"),
  trackingUid: code("112040", "DCM", "Tracking Unique Identifier"),
  finding: code("121071", "DCM", "Finding"),
  imageRegion: code("111030", "DCM", "Image Region"),
  patientRegion: code("PATIENT-REGION", SCHEME, "Image Region (patient coordinates)"),
  annotationText: code("ANNOTATION-TEXT", SCHEME, "Annotation text"),
  drawnAt: code("DRAWN-AT-MS", SCHEME, "Time on narration track"),
  millisecond: code("ms", "UCUM", "millisecond"),
} as const;

const KIND_CODE: Record<TeacherSketchItem["kind"], Dataset> = {
  pen: code("SKETCH-PEN", SCHEME, "Freehand sketch"),
  arrow: code("SKETCH-ARROW", SCHEME, "Arrow"),
  ellipse: code("SKETCH-ELLIPSE", SCHEME, "Ellipse"),
  text: code("SKETCH-TEXT", SCHEME, "Text annotation"),
  marker: code("FINDING-MARKER", SCHEME, "Finding marker"),
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface Placed {
  item: TeacherSketchItem;
  /** Pixel indices (centre = integer). */
  idx: { col: number; row: number }[];
  mm: [number, number, number][] | null;
  sopClassUID: string;
  frameNumber?: number;
}

function indexOf(p: SketchImagePoint, columns?: number, rows?: number): { col: number; row: number } | null {
  if (p.col != null && p.row != null && Number.isFinite(p.col) && Number.isFinite(p.row)) return { col: p.col, row: p.row };
  if (columns && rows) return fractionToIndex(p.x_pct, p.y_pct, columns, rows);
  return null;
}

function place(item: TeacherSketchItem, ctx: SketchExportContext): Placed | { skip: string } {
  if (!item.image.sopInstanceUID) return { skip: "no SOP Instance UID (bundled sample or local file)" };
  const columns = item.image.columns ?? ctx.columns;
  const rows = item.image.rows ?? ctx.rows;
  const idx = item.points.map((p) => indexOf(p, columns, rows));
  if (idx.some((p) => !p)) return { skip: "no pixel grid for this image" };
  const mm = item.points.every((p) => p.mm) ? item.points.map((p) => p.mm!) : null;
  return {
    item,
    idx: idx as { col: number; row: number }[],
    mm,
    sopClassUID: item.image.sopClassUID ?? ctx.sopClassUID ?? SOP_CLASS.ctImage,
    ...(item.image.frameNumber != null ? { frameNumber: item.image.frameNumber } : {}),
  };
}

/** Bounding-box corners → DICOM ELLIPSE: major-axis endpoints, then minor (pixel index). */
function ellipseAxes(a: { col: number; row: number }, b: { col: number; row: number }): Array<[number, number]> {
  const cx = (a.col + b.col) / 2;
  const cy = (a.row + b.row) / 2;
  const rx = Math.abs(b.col - a.col) / 2;
  const ry = Math.abs(b.row - a.row) / 2;
  return rx >= ry
    ? [[cx - rx, cy], [cx + rx, cy], [cx, cy - ry], [cx, cy + ry]]
    : [[cx, cy - ry], [cx, cy + ry], [cx - rx, cy], [cx + rx, cy]];
}

function ellipse2d(a: { col: number; row: number }, b: { col: number; row: number }): number[] {
  return ellipseAxes(a, b).flatMap(([c, r]) => indexToScoord(c, r));
}

function planeOf(item: TeacherSketchItem, ctx: SketchExportContext): DicomImagePlane | null {
  const plane = item.image.plane;
  const columns = item.image.columns ?? ctx.columns;
  const rows = item.image.rows ?? ctx.rows;
  if (!plane || !columns || !rows) return null;
  return { ...plane, columns, rows };
}

function scoordData(placed: Placed): { type: string; data: number[] } {
  const { item, idx } = placed;
  if (item.kind === "ellipse") return { type: "ELLIPSE", data: ellipse2d(idx[0]!, idx[idx.length - 1]!) };
  if (item.kind === "text" || item.kind === "marker") return { type: "POINT", data: indexToScoord(idx[0]!.col, idx[0]!.row) };
  return { type: "POLYLINE", data: idx.flatMap((p) => indexToScoord(p.col, p.row)) };
}

/**
 * Patient-mm geometry. Prefers the stored per-point mm; otherwise maps the
 * pixel indices through the stored image plane. Ellipses always go through
 * the plane: their DICOM axis endpoints are not the drawn corners.
 */
function scoord3dData(placed: Placed, plane: DicomImagePlane | null): { type: string; data: number[] } | null {
  const { item, idx } = placed;
  const toMm = (col: number, row: number) => indexToPatient(col, row, plane);
  if (item.kind === "ellipse") {
    const axes = ellipseAxes(idx[0]!, idx[idx.length - 1]!).map(([c, r]) => toMm(c, r));
    return axes.every(Boolean) ? { type: "ELLIPSE", data: axes.flatMap((p) => [...p!]) } : null;
  }
  const mm = placed.mm ?? (plane ? idx.map((p) => toMm(p.col, p.row)) : null);
  if (!mm || mm.some((p) => !p)) return null;
  const pts = mm as [number, number, number][];
  if (item.kind === "text" || item.kind === "marker") return { type: "POINT", data: [...pts[0]!] };
  return { type: "POLYLINE", data: pts.flatMap((p) => [...p]) };
}

// ---------------------------------------------------------------------------
// SR
// ---------------------------------------------------------------------------

function imageRef(placed: Placed): Dataset {
  return {
    ReferencedSOPClassUID: placed.sopClassUID,
    ReferencedSOPInstanceUID: placed.item.image.sopInstanceUID,
    ...(placed.frameNumber != null ? { ReferencedFrameNumber: placed.frameNumber } : {}),
  };
}

function patientStudyModules(ctx: SketchExportContext): Dataset {
  return {
    PatientName: ctx.patientName ?? "",
    PatientID: ctx.patientID ?? "",
    PatientBirthDate: ctx.patientBirthDate ?? "",
    PatientSex: ctx.patientSex ?? "",
    StudyInstanceUID: ctx.studyInstanceUID,
    StudyDate: ctx.studyDate ?? "",
    StudyTime: ctx.studyTime ?? "",
    ReferringPhysicianName: ctx.referringPhysicianName ?? "",
    StudyID: ctx.studyID ?? "",
    AccessionNumber: ctx.accessionNumber ?? "",
  };
}

function evidence(placed: Placed[], studyInstanceUID: string): Dataset[] {
  const bySeries = new Map<string, Map<string, Placed>>();
  for (const p of placed) {
    const series = p.item.image.seriesInstanceUID ?? "";
    if (!bySeries.has(series)) bySeries.set(series, new Map());
    bySeries.get(series)!.set(`${p.item.image.sopInstanceUID}|${p.frameNumber ?? ""}`, p);
  }
  return [
    {
      StudyInstanceUID: studyInstanceUID,
      ReferencedSeriesSequence: [...bySeries.entries()]
        .filter(([series]) => series)
        .map(([series, sops]) => ({
          SeriesInstanceUID: series,
          ReferencedSOPSequence: [...sops.values()].map((p) => ({
            ReferencedSOPClassUID: p.sopClassUID,
            ReferencedSOPInstanceUID: p.item.image.sopInstanceUID,
          })),
        })),
    },
  ];
}

export interface SketchTiming {
  /** Track ms each item began drawing (from the recorded timeline). */
  tMs?: Record<string, number>;
}

function toPart10(dataset: Dataset, sopClassUID: string, sopInstanceUID: string): ArrayBuffer {
  const { DicomMetaDictionary, DicomDict } = dcmjs.data;
  const meta = {
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: sopClassUID,
    MediaStorageSOPInstanceUID: sopInstanceUID,
    TransferSyntaxUID: EXPLICIT_VR_LE,
    ImplementationClassUID: IMPLEMENTATION_UID,
    ImplementationVersionName: "FLOWRAD_SKETCH1",
  };
  const dict = new DicomDict(DicomMetaDictionary.denaturalizeDataset(meta));
  dict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  return dict.write();
}

function partition(items: readonly TeacherSketchItem[], ctx: SketchExportContext) {
  const placed: Placed[] = [];
  const skipped: SketchExportResult["skipped"] = [];
  for (const item of items) {
    if (item.image.studyInstanceUID && item.image.studyInstanceUID !== ctx.studyInstanceUID) {
      skipped.push({ id: item.id, reason: "different study" });
      continue;
    }
    const p = place(item, ctx);
    if ("skip" in p) skipped.push({ id: item.id, reason: p.skip });
    else placed.push(p);
  }
  return { placed, skipped };
}

function itemLabel(item: TeacherSketchItem): string {
  if (item.kind === "marker") return `${item.number != null ? `#${item.number} ` : ""}${item.text ?? "Finding"}`;
  if (item.kind === "text") return item.text ?? "Text";
  return (KIND_CODE[item.kind].CodeMeaning as string) ?? item.kind;
}

/** Build the TID 1500 SR as a naturalized dcmjs dataset (exposed for tests). */
export function buildSketchSrDataset(
  items: readonly TeacherSketchItem[],
  ctx: SketchExportContext,
  opts: { now?: Date; timing?: SketchTiming; sopInstanceUID?: string; seriesInstanceUID?: string } = {}
): { dataset: Dataset; written: string[]; skipped: SketchExportResult["skipped"]; trackingUids: Record<string, string> } {
  const now = opts.now ?? new Date();
  const { placed, skipped } = partition(items, ctx);
  const sopInstanceUID = opts.sopInstanceUID ?? newUid();
  const seriesInstanceUID = opts.seriesInstanceUID ?? newUid();
  const trackingUids: Record<string, string> = {};

  const groups = placed.map((p) => {
    const trackingUid = newUid();
    trackingUids[p.item.id] = trackingUid;
    const scoord = scoordData(p);
    const s3 = scoord3dData(p, planeOf(p.item, ctx));
    const frameOfReferenceUID = p.item.image.frameOfReferenceUID ?? ctx.frameOfReferenceUID;
    const content: Dataset[] = [
      {
        RelationshipType: "HAS OBS CONTEXT",
        ValueType: "TEXT",
        ConceptNameCodeSequence: [CODES.trackingId],
        TextValue: `${TRACKING_PREFIX}:${p.item.kind}:${p.item.id}`,
      },
      {
        RelationshipType: "HAS OBS CONTEXT",
        ValueType: "UIDREF",
        ConceptNameCodeSequence: [CODES.trackingUid],
        UID: trackingUid,
      },
      {
        RelationshipType: "CONTAINS",
        ValueType: "CODE",
        ConceptNameCodeSequence: [CODES.finding],
        ConceptCodeSequence: [code(KIND_CODE[p.item.kind].CodeValue as string, SCHEME, itemLabel(p.item))],
      },
    ];
    if (p.item.text) {
      content.push({
        RelationshipType: "CONTAINS",
        ValueType: "TEXT",
        ConceptNameCodeSequence: [CODES.annotationText],
        TextValue: p.item.text,
      });
    }
    const t = opts.timing?.tMs?.[p.item.id];
    if (t != null && Number.isFinite(t)) {
      content.push({
        RelationshipType: "CONTAINS",
        ValueType: "NUM",
        ConceptNameCodeSequence: [CODES.drawnAt],
        MeasuredValueSequence: [{ NumericValue: Math.round(t), MeasurementUnitsCodeSequence: [CODES.millisecond] }],
      });
    }
    content.push({
      RelationshipType: "CONTAINS",
      ValueType: "SCOORD",
      ConceptNameCodeSequence: [CODES.imageRegion],
      GraphicType: scoord.type,
      GraphicData: scoord.data,
      ContentSequence: [
        {
          RelationshipType: "SELECTED FROM",
          ValueType: "IMAGE",
          ReferencedSOPSequence: [imageRef(p)],
        },
      ],
    });
    if (s3 && frameOfReferenceUID) {
      content.push({
        RelationshipType: "CONTAINS",
        ValueType: "SCOORD3D",
        ConceptNameCodeSequence: [CODES.patientRegion],
        GraphicType: s3.type,
        GraphicData: s3.data,
        ReferencedFrameOfReferenceUID: frameOfReferenceUID,
      });
    }
    return {
      RelationshipType: "CONTAINS",
      ValueType: "CONTAINER",
      ConceptNameCodeSequence: [CODES.group],
      ContinuityOfContent: "SEPARATE",
      ContentTemplateSequence: [{ MappingResource: "DCMR", TemplateIdentifier: "1410" }],
      ContentSequence: content,
    };
  });

  const uniqueImages = new Map<string, Placed>();
  for (const p of placed) uniqueImages.set(`${p.item.image.sopInstanceUID}|${p.frameNumber ?? ""}`, p);

  const dataset: Dataset = {
    SpecificCharacterSet: "ISO_IR 192",
    SOPClassUID: SOP_CLASS.comprehensive3dSr,
    SOPInstanceUID: sopInstanceUID,
    ...patientStudyModules(ctx),
    Modality: "SR",
    SeriesInstanceUID: seriesInstanceUID,
    SeriesNumber: 9901,
    SeriesDescription: "FlowRad teacher sketch",
    Manufacturer: "FlowRad Learn",
    InstanceNumber: 1,
    ContentDate: dicomDate(now),
    ContentTime: dicomTime(now),
    InstanceCreationDate: dicomDate(now),
    InstanceCreationTime: dicomTime(now),
    CompletionFlag: "COMPLETE",
    VerificationFlag: "UNVERIFIED",
    ValueType: "CONTAINER",
    ConceptNameCodeSequence: [CODES.report],
    ContinuityOfContent: "SEPARATE",
    ContentTemplateSequence: [{ MappingResource: "DCMR", TemplateIdentifier: "1500" }],
    CurrentRequestedProcedureEvidenceSequence: evidence(placed, ctx.studyInstanceUID),
    ContentSequence: [
      {
        RelationshipType: "HAS CONCEPT MOD",
        ValueType: "CODE",
        ConceptNameCodeSequence: [CODES.language],
        ConceptCodeSequence: [CODES.english],
      },
      {
        RelationshipType: "HAS OBS CONTEXT",
        ValueType: "CODE",
        ConceptNameCodeSequence: [CODES.observerType],
        ConceptCodeSequence: [CODES.person],
      },
      {
        RelationshipType: "HAS OBS CONTEXT",
        ValueType: "PNAME",
        ConceptNameCodeSequence: [CODES.personName],
        PersonName: ctx.observerName ?? "FlowRad^Teacher",
      },
      {
        RelationshipType: "HAS CONCEPT MOD",
        ValueType: "CODE",
        ConceptNameCodeSequence: [CODES.procedure],
        ConceptCodeSequence: [CODES.imagingProcedure],
      },
      {
        RelationshipType: "CONTAINS",
        ValueType: "CONTAINER",
        ConceptNameCodeSequence: [CODES.imageLibrary],
        ContinuityOfContent: "SEPARATE",
        ContentSequence: [
          {
            RelationshipType: "CONTAINS",
            ValueType: "CONTAINER",
            ConceptNameCodeSequence: [CODES.imageLibraryGroup],
            ContinuityOfContent: "SEPARATE",
            ContentSequence: [...uniqueImages.values()].map((p) => ({
              RelationshipType: "CONTAINS",
              ValueType: "IMAGE",
              ReferencedSOPSequence: [imageRef(p)],
            })),
          },
        ],
      },
      {
        RelationshipType: "CONTAINS",
        ValueType: "CONTAINER",
        ConceptNameCodeSequence: [CODES.measurements],
        ContinuityOfContent: "SEPARATE",
        ContentSequence: groups,
      },
    ],
  };
  return { dataset, written: placed.map((p) => p.item.id), skipped, trackingUids };
}

export function exportSketchSr(
  items: readonly TeacherSketchItem[],
  ctx: SketchExportContext,
  opts: { now?: Date; timing?: SketchTiming } = {}
): SketchExportResult & { trackingUids: Record<string, string> } {
  const sopInstanceUID = newUid();
  const seriesInstanceUID = newUid();
  const built = buildSketchSrDataset(items, ctx, { ...opts, sopInstanceUID, seriesInstanceUID });
  return {
    bytes: toPart10(built.dataset, SOP_CLASS.comprehensive3dSr, sopInstanceUID),
    sopInstanceUID,
    seriesInstanceUID,
    written: built.written,
    skipped: built.skipped,
    trackingUids: built.trackingUids,
  };
}

// ---------------------------------------------------------------------------
// GSPS
// ---------------------------------------------------------------------------

const GSPS_LAYER = "FLOWRAD_SKETCH";

function arrowHead(tail: number[], tip: number[]): number[][] {
  const angle = Math.atan2(tip[1]! - tail[1]!, tip[0]! - tail[0]!);
  const len = Math.hypot(tip[0]! - tail[0]!, tip[1]! - tail[1]!);
  const head = Math.max(3, Math.min(12, len * 0.22));
  return [1, -1].map((side) => {
    const a = angle + Math.PI - side * 0.5;
    return [tip[0]! + Math.cos(a) * head, tip[1]! + Math.sin(a) * head, tip[0]!, tip[1]!];
  });
}

export function buildSketchGspsDataset(
  items: readonly TeacherSketchItem[],
  ctx: SketchExportContext,
  opts: { now?: Date; sopInstanceUID?: string; seriesInstanceUID?: string } = {}
): { dataset: Dataset; written: string[]; skipped: SketchExportResult["skipped"] } {
  const now = opts.now ?? new Date();
  const { placed, skipped } = partition(items, ctx);
  const byImage = new Map<string, Placed[]>();
  for (const p of placed) {
    const key = `${p.item.image.sopInstanceUID}|${p.frameNumber ?? ""}`;
    if (!byImage.has(key)) byImage.set(key, []);
    byImage.get(key)!.push(p);
  }
  const annotations = [...byImage.values()].map((list) => {
    const graphics: Dataset[] = [];
    const texts: Dataset[] = [];
    for (const p of list) {
      const s = scoordData(p);
      const push = (type: string, data: number[]) =>
        graphics.push({
          GraphicAnnotationUnits: "PIXEL",
          GraphicDimensions: 2,
          NumberOfGraphicPoints: data.length / 2,
          GraphicData: data,
          GraphicType: type,
          GraphicFilled: "N",
        });
      if (p.item.kind === "arrow") {
        const tail = s.data.slice(0, 2);
        const tip = s.data.slice(-2);
        push("POLYLINE", [...tail, ...tip]);
        for (const head of arrowHead(tail, tip)) push("POLYLINE", head);
      } else if (p.item.kind === "ellipse") {
        push("ELLIPSE", s.data);
      } else if (p.item.kind === "pen") {
        push("POLYLINE", s.data);
      } else {
        push("POINT", s.data);
      }
      if (p.item.kind === "marker" || p.item.kind === "text") {
        texts.push({
          AnchorPointAnnotationUnits: "PIXEL",
          AnchorPoint: s.data.slice(0, 2),
          AnchorPointVisibility: "Y",
          UnformattedTextValue: itemLabel(p.item).slice(0, 1024),
        });
      }
    }
    return {
      ReferencedImageSequence: [imageRef(list[0]!)],
      GraphicLayer: GSPS_LAYER,
      GraphicObjectSequence: graphics,
      ...(texts.length ? { TextObjectSequence: texts } : {}),
    };
  });

  const bySeries = new Map<string, Placed[]>();
  for (const p of placed) {
    const s = p.item.image.seriesInstanceUID ?? "";
    if (!bySeries.has(s)) bySeries.set(s, []);
    bySeries.get(s)!.push(p);
  }
  const first = placed[0];
  const columns = first?.item.image.columns ?? ctx.columns ?? 512;
  const rows = first?.item.image.rows ?? ctx.rows ?? 512;

  const dataset: Dataset = {
    SpecificCharacterSet: "ISO_IR 192",
    SOPClassUID: SOP_CLASS.gsps,
    SOPInstanceUID: opts.sopInstanceUID ?? newUid(),
    ...patientStudyModules(ctx),
    Modality: "PR",
    SeriesInstanceUID: opts.seriesInstanceUID ?? newUid(),
    SeriesNumber: 9902,
    SeriesDescription: "FlowRad teacher sketch (GSPS)",
    Manufacturer: "FlowRad Learn",
    InstanceNumber: 1,
    ContentLabel: GSPS_LAYER,
    ContentDescription: "Teacher sketch and finding markers",
    ContentCreatorName: ctx.observerName ?? "FlowRad^Teacher",
    PresentationCreationDate: dicomDate(now),
    PresentationCreationTime: dicomTime(now),
    ReferencedSeriesSequence: [...bySeries.entries()]
      .filter(([s]) => s)
      .map(([s, list]) => ({
        SeriesInstanceUID: s,
        ReferencedImageSequence: [...new Map(list.map((p) => [`${p.item.image.sopInstanceUID}|${p.frameNumber ?? ""}`, p])).values()].map(imageRef),
      })),
    DisplayedAreaSelectionSequence: [
      {
        DisplayedAreaTopLeftHandCorner: [1, 1],
        DisplayedAreaBottomRightHandCorner: [columns, rows],
        PresentationSizeMode: "SCALE TO FIT",
        PresentationPixelAspectRatio: [1, 1],
      },
    ],
    GraphicLayerSequence: [
      {
        GraphicLayer: GSPS_LAYER,
        GraphicLayerOrder: 1,
        GraphicLayerRecommendedDisplayGrayscaleValue: 65535,
        GraphicLayerRecommendedDisplayCIELabValue: [62914, 33153, 50890],
        GraphicLayerDescription: "FlowRad teacher sketch",
      },
    ],
    GraphicAnnotationSequence: annotations,
    PresentationLUTShape: "IDENTITY",
  };
  return { dataset, written: placed.map((p) => p.item.id), skipped };
}

export function exportSketchGsps(
  items: readonly TeacherSketchItem[],
  ctx: SketchExportContext,
  opts: { now?: Date } = {}
): SketchExportResult {
  const sopInstanceUID = newUid();
  const seriesInstanceUID = newUid();
  const built = buildSketchGspsDataset(items, ctx, { ...opts, sopInstanceUID, seriesInstanceUID });
  return {
    bytes: toPart10(built.dataset, SOP_CLASS.gsps, sopInstanceUID),
    sopInstanceUID,
    seriesInstanceUID,
    written: built.written,
    skipped: built.skipped,
  };
}

// ---------------------------------------------------------------------------
// Read-back (round-trip tests, and importing a teacher SR later)
// ---------------------------------------------------------------------------

export interface ReadSketchGroup {
  trackingId: string;
  trackingUid?: string;
  kind?: string;
  itemId?: string;
  label?: string;
  text?: string;
  tMs?: number;
  graphicType: string;
  /** Pixel indices recovered from SCOORD (centre = integer). */
  idx: { col: number; row: number }[];
  sopInstanceUID?: string;
  frameNumber?: number;
  mm?: number[][];
  frameOfReferenceUID?: string;
}

function arr<T = Dataset>(value: unknown): T[] {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

function codeValue(item: Dataset, key: string): string | undefined {
  return arr<Dataset>(item[key])[0]?.CodeValue as string | undefined;
}

/** Parse a Part-10 SR buffer back into measurement groups. */
export function readSketchSr(bytes: ArrayBuffer): { dataset: Dataset; groups: ReadSketchGroup[] } {
  const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
  const file = DicomMessage.readFile(bytes);
  const dataset = DicomMetaDictionary.naturalizeDataset(file.dict);
  const root = arr<Dataset>(dataset.ContentSequence);
  const measurements = root.find((c) => codeValue(c, "ConceptNameCodeSequence") === "126010");
  const groups: ReadSketchGroup[] = [];
  for (const group of arr<Dataset>(measurements?.ContentSequence)) {
    const items = arr<Dataset>(group.ContentSequence);
    const trackingId = (items.find((c) => codeValue(c, "ConceptNameCodeSequence") === "112039")?.TextValue as string) ?? "";
    const trackingUid = items.find((c) => codeValue(c, "ConceptNameCodeSequence") === "112040")?.UID as string | undefined;
    const finding = items.find((c) => codeValue(c, "ConceptNameCodeSequence") === "121071");
    const text = items.find((c) => codeValue(c, "ConceptNameCodeSequence") === "ANNOTATION-TEXT")?.TextValue as string | undefined;
    const timed = items.find((c) => codeValue(c, "ConceptNameCodeSequence") === "DRAWN-AT-MS");
    const scoord = items.find((c) => c.ValueType === "SCOORD");
    const s3 = items.find((c) => c.ValueType === "SCOORD3D");
    if (!scoord) continue;
    const data = arr<number>(scoord.GraphicData).map(Number);
    const idx: { col: number; row: number }[] = [];
    for (let i = 0; i + 1 < data.length; i += 2) idx.push(scoordToIndex(data[i]!, data[i + 1]!));
    const ref = arr<Dataset>(arr<Dataset>(scoord.ContentSequence)[0]?.ReferencedSOPSequence)[0];
    const [, kind, itemId] = trackingId.split(":");
    const mmFlat = s3 ? arr<number>(s3.GraphicData).map(Number) : [];
    const mm: number[][] = [];
    for (let i = 0; i + 2 < mmFlat.length; i += 3) mm.push([mmFlat[i]!, mmFlat[i + 1]!, mmFlat[i + 2]!]);
    const frame = ref?.ReferencedFrameNumber;
    groups.push({
      trackingId,
      trackingUid,
      kind,
      itemId,
      label: arr<Dataset>(finding?.ConceptCodeSequence)[0]?.CodeMeaning as string | undefined,
      text,
      tMs: timed ? Number(arr<Dataset>(timed.MeasuredValueSequence)[0]?.NumericValue) : undefined,
      graphicType: scoord.GraphicType as string,
      idx,
      sopInstanceUID: ref?.ReferencedSOPInstanceUID as string | undefined,
      ...(frame != null ? { frameNumber: Number(Array.isArray(frame) ? frame[0] : frame) } : {}),
      ...(mm.length ? { mm, frameOfReferenceUID: s3?.ReferencedFrameOfReferenceUID as string } : {}),
    });
  }
  return { dataset, groups };
}

/** Parse a Part-10 GSPS buffer into its graphic objects (tests). */
export function readSketchGsps(bytes: ArrayBuffer): Dataset {
  const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
  const file = DicomMessage.readFile(bytes);
  return DicomMetaDictionary.naturalizeDataset(file.dict);
}
