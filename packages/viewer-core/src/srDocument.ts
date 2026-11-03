// DICOM Structured Reports and Key Object Selection notes, read in the page.
//
// The same reading the desktop shell does in Rust (desktop/src-tauri/src/
// documents.rs), so a report reads identically on both: the content tree
// flattened to one line per item (TEXT, CODE, NUM with units, PNAME, DATE,
// UIDREF), indented two spaces per level, plus the SOP Instance UIDs of every
// image it references. A key-image note becomes a series of those images.

/** Structured Report SOP classes all start with this; KO is one of them. */
export const SR_SOP_CLASS_PREFIX = "1.2.840.10008.5.1.4.1.1.88.";
export const KEY_OBJECT_SELECTION_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.88.59";

export interface DicomDocument {
  kind: "sr" | "ko";
  fileName: string;
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  /** Root concept name, e.g. "Imaging Measurement Report". */
  title: string;
  /** DICOM DA (YYYYMMDD). */
  date?: string;
  /** Content tree, one line per item, two-space indent per level. */
  lines: string[];
  /** SOP Instance UIDs it points at, in document order. */
  references: string[];
}

export function isStructuredDocumentClass(sopClassUid: string | undefined): boolean {
  return !!sopClassUid && sopClassUid.trim().startsWith(SR_SOP_CLASS_PREFIX);
}

/** The slice of dicom-parser's DataSet this module reads. */
export interface SrDataSet {
  string(tag: string): string | undefined;
  elements: Record<string, { items?: { dataSet?: SrDataSet }[] } | undefined>;
}

const TAG = {
  sopClassUid: "x00080016",
  sopInstanceUid: "x00080018",
  studyInstanceUid: "x0020000d",
  seriesInstanceUid: "x0020000e",
  seriesDescription: "x0008103e",
  contentDate: "x00080023",
  studyDate: "x00080020",
  contentSequence: "x0040a730",
  valueType: "x0040a040",
  conceptNameCodeSequence: "x0040a043",
  conceptCodeSequence: "x0040a168",
  textValue: "x0040a160",
  measuredValueSequence: "x0040a300",
  numericValue: "x0040a30a",
  measurementUnitsCodeSequence: "x004008ea",
  personName: "x0040a123",
  date: "x0040a121",
  uid: "x0040a124",
  referencedSopSequence: "x00081199",
  referencedSopInstanceUid: "x00081155",
  codeValue: "x00080100",
  codeMeaning: "x00080104",
} as const;

function text(ds: SrDataSet | undefined, tag: string): string | undefined {
  const v = ds?.string(tag)?.replace(/\0/g, "").trim();
  return v ? v : undefined;
}

function items(ds: SrDataSet | undefined, tag: string): SrDataSet[] {
  return (ds?.elements[tag]?.items ?? []).map((i) => i.dataSet).filter((d): d is SrDataSet => !!d);
}

function codeMeaning(ds: SrDataSet, seq: string): string | undefined {
  return text(items(ds, seq)[0], TAG.codeMeaning);
}

function walk(ds: SrDataSet, depth: number, lines: string[], refs: string[]): void {
  for (const item of items(ds, TAG.contentSequence)) {
    const name = codeMeaning(item, TAG.conceptNameCodeSequence);
    const valueType = text(item, TAG.valueType) ?? "";
    let value: string | undefined;
    switch (valueType) {
      case "TEXT":
        value = text(item, TAG.textValue);
        break;
      case "CODE":
        value = codeMeaning(item, TAG.conceptCodeSequence);
        break;
      case "NUM": {
        const measured = items(item, TAG.measuredValueSequence)[0];
        const n = text(measured, TAG.numericValue);
        if (n) {
          const unit = text(items(measured!, TAG.measurementUnitsCodeSequence)[0], TAG.codeValue);
          value = unit && unit !== "1" ? `${n} ${unit}` : n;
        }
        break;
      }
      case "PNAME":
        value = text(item, TAG.personName)?.replace(/\^/g, " ").trim();
        break;
      case "DATE":
        value = text(item, TAG.date);
        break;
      case "UIDREF":
        value = text(item, TAG.uid);
        break;
      case "IMAGE":
      case "COMPOSITE": {
        const uid = text(items(item, TAG.referencedSopSequence)[0], TAG.referencedSopInstanceUid);
        if (uid && !refs.includes(uid)) refs.push(uid);
        value = "image";
        break;
      }
      default:
        value = undefined;
    }
    let line = "";
    if (name && value && valueType !== "CONTAINER") line = `${name}: ${value}`;
    else if (name) line = name;
    else if (value) line = value;
    if (line && valueType !== "IMAGE") lines.push(`${"  ".repeat(depth)}${line}`);
    walk(item, depth + 1, lines, refs);
  }
}

/** A Structured Report or Key Object Selection document; null for anything else. */
export function documentFromDataSet(ds: SrDataSet, fileName: string): DicomDocument | null {
  const sopClass = text(ds, TAG.sopClassUid);
  if (!isStructuredDocumentClass(sopClass)) return null;
  const kind = sopClass === KEY_OBJECT_SELECTION_SOP_CLASS ? "ko" : "sr";
  const lines: string[] = [];
  const references: string[] = [];
  walk(ds, 0, lines, references);
  return {
    kind,
    fileName,
    studyInstanceUid: text(ds, TAG.studyInstanceUid),
    seriesInstanceUid: text(ds, TAG.seriesInstanceUid),
    sopInstanceUid: text(ds, TAG.sopInstanceUid),
    title:
      codeMeaning(ds, TAG.conceptNameCodeSequence) ??
      text(ds, TAG.seriesDescription) ??
      (kind === "ko" ? "Key images" : "Structured report"),
    date: text(ds, TAG.contentDate) ?? text(ds, TAG.studyDate),
    lines,
    references,
  };
}

/** Structured reports that belong to a study (key-image notes are series instead). */
export function reportsForStudy(studyUid: string, documents: readonly DicomDocument[]): DicomDocument[] {
  return documents.filter((d) => d.kind === "sr" && (!d.studyInstanceUid || d.studyInstanceUid === studyUid));
}

/** "Key images" or "Key images · <title>" for a note's series. */
export function keyImageSeriesDescription(note: DicomDocument): string {
  return `Key images${note.title && note.title !== "Key images" ? ` · ${note.title}` : ""}`;
}
