/**
 * The DICOM tags viewer's model: element names for the tags a reader looks
 * at (PS3.6), which tags identify the patient (masked when the app hides
 * patient details), and how to list a parsed header's elements in order.
 * Pure; the app supplies the parsed dataset (dicom-parser shape).
 */

/** Tag (GGGGEEEE, upper case) → keyword-style name. */
export const DICOM_TAG_NAMES: Readonly<Record<string, string>> = {
  "00020010": "Transfer Syntax UID",
  "00080005": "Specific Character Set",
  "00080008": "Image Type",
  "00080016": "SOP Class UID",
  "00080018": "SOP Instance UID",
  "00080020": "Study Date",
  "00080021": "Series Date",
  "00080022": "Acquisition Date",
  "00080023": "Content Date",
  "00080030": "Study Time",
  "00080031": "Series Time",
  "00080032": "Acquisition Time",
  "00080033": "Content Time",
  "00080050": "Accession Number",
  "00080060": "Modality",
  "00080070": "Manufacturer",
  "00080080": "Institution Name",
  "00080081": "Institution Address",
  "00080090": "Referring Physician's Name",
  "00081010": "Station Name",
  "00081030": "Study Description",
  "0008103E": "Series Description",
  "00081040": "Institutional Department Name",
  "00081050": "Performing Physician's Name",
  "00081070": "Operators' Name",
  "00081090": "Manufacturer's Model Name",
  "00082144": "Recommended Display Frame Rate",
  "00100010": "Patient's Name",
  "00100020": "Patient ID",
  "00100030": "Patient's Birth Date",
  "00100040": "Patient's Sex",
  "00101010": "Patient's Age",
  "00101020": "Patient's Size",
  "00101030": "Patient's Weight",
  "00180010": "Contrast/Bolus Agent",
  "00180015": "Body Part Examined",
  "00180020": "Scanning Sequence",
  "00180021": "Sequence Variant",
  "00180022": "Scan Options",
  "00180023": "MR Acquisition Type",
  "00180024": "Sequence Name",
  "00180040": "Cine Rate",
  "00180050": "Slice Thickness",
  "00180060": "KVP",
  "00180080": "Repetition Time",
  "00180081": "Echo Time",
  "00180082": "Inversion Time",
  "00180083": "Number of Averages",
  "00180084": "Imaging Frequency",
  "00180087": "Magnetic Field Strength",
  "00180088": "Spacing Between Slices",
  "00180091": "Echo Train Length",
  "00181020": "Software Versions",
  "00181030": "Protocol Name",
  "00181063": "Frame Time",
  "00181088": "Heart Rate",
  "00181100": "Reconstruction Diameter",
  "00181110": "Distance Source to Detector",
  "00181111": "Distance Source to Patient",
  "00181120": "Gantry/Detector Tilt",
  "00181130": "Table Height",
  "00181150": "Exposure Time",
  "00181151": "X-Ray Tube Current",
  "00181152": "Exposure",
  "00181160": "Filter Type",
  "00181210": "Convolution Kernel",
  "00181250": "Receive Coil Name",
  "00181310": "Acquisition Matrix",
  "00181314": "Flip Angle",
  "00185100": "Patient Position",
  "00189087": "Diffusion b-value",
  "0020000D": "Study Instance UID",
  "0020000E": "Series Instance UID",
  "00200010": "Study ID",
  "00200011": "Series Number",
  "00200012": "Acquisition Number",
  "00200013": "Instance Number",
  "00200020": "Patient Orientation",
  "00200032": "Image Position (Patient)",
  "00200037": "Image Orientation (Patient)",
  "00200052": "Frame of Reference UID",
  "00201041": "Slice Location",
  "00280002": "Samples per Pixel",
  "00280004": "Photometric Interpretation",
  "00280008": "Number of Frames",
  "00280010": "Rows",
  "00280011": "Columns",
  "00280030": "Pixel Spacing",
  "00280100": "Bits Allocated",
  "00280101": "Bits Stored",
  "00280102": "High Bit",
  "00280103": "Pixel Representation",
  "00281050": "Window Center",
  "00281051": "Window Width",
  "00281052": "Rescale Intercept",
  "00281053": "Rescale Slope",
  "00281054": "Rescale Type",
  "00282110": "Lossy Image Compression",
  "00321060": "Requested Procedure Description",
  "00400244": "Performed Procedure Step Start Date",
  "00400254": "Performed Procedure Step Description",
  "00540081": "Number of Slices",
  "00541001": "Units",
  "00541102": "Decay Correction",
  "7FE00010": "Pixel Data",
};

/** Tags that identify the patient or the people involved (PS3.15-style), masked when patient details are hidden. */
export function isIdentifyingTag(tag: string): boolean {
  const t = tag.toUpperCase().replace(/^X/, "");
  return (
    t.startsWith("0010") ||
    ["00080050", "00080080", "00080081", "00080090", "00081040", "00081050", "00081070", "00200010", "00081010"].includes(t)
  );
}

export interface DicomTagRow {
  /** "(0010,0010)". */
  tag: string;
  name: string;
  vr?: string;
  value: string;
  identifying: boolean;
}

/** The parts of a dicom-parser DataSet the viewer reads. */
export interface TagDataSet {
  elements: Record<string, { tag: string; vr?: string; length: number; items?: unknown[] }>;
  string(tag: string): string | undefined;
  uint16?(tag: string, index?: number): number | undefined;
  int16?(tag: string, index?: number): number | undefined;
  uint32?(tag: string, index?: number): number | undefined;
  float?(tag: string, index?: number): number | undefined;
  double?(tag: string, index?: number): number | undefined;
}

const TEXT_VRS = new Set(["AE", "AS", "CS", "DA", "DS", "DT", "IS", "LO", "LT", "PN", "SH", "ST", "TM", "UC", "UI", "UR", "UT"]);

/** One row per top-level element, in tag order; long values shortened. */
export function tagRows(ds: TagDataSet, { hideIdentifying = false, maxValue = 160 } = {}): DicomTagRow[] {
  return Object.keys(ds.elements)
    .sort()
    .map((key) => {
      const el = ds.elements[key];
      const hex = key.replace(/^x/, "").toUpperCase();
      const tag = `(${hex.slice(0, 4)},${hex.slice(4)})`;
      const identifying = isIdentifyingTag(hex);
      let value: string;
      if (el.items) value = `Sequence · ${el.items.length} item${el.items.length === 1 ? "" : "s"}`;
      else if (hex === "7FE00010") value = `${el.length.toLocaleString()} bytes`;
      else if (!el.vr || TEXT_VRS.has(el.vr)) value = (ds.string(key) ?? "").trim();
      else if (el.vr === "US") value = String(ds.uint16?.(key) ?? "");
      else if (el.vr === "SS") value = String(ds.int16?.(key) ?? "");
      else if (el.vr === "UL") value = String(ds.uint32?.(key) ?? "");
      else if (el.vr === "FL") value = String(ds.float?.(key) ?? "");
      else if (el.vr === "FD") value = String(ds.double?.(key) ?? "");
      else value = `${el.length.toLocaleString()} bytes`;
      if (hideIdentifying && identifying && value) value = "(hidden)";
      if (value.length > maxValue) value = `${value.slice(0, maxValue - 1)}…`;
      const group = parseInt(hex.slice(0, 4), 16);
      const name = DICOM_TAG_NAMES[hex] ?? (group % 2 === 1 ? "Private tag" : "");
      return { tag, name, vr: el.vr, value, identifying };
    });
}

/** Rows matching a search (tag, name or value). */
export function filterTagRows(rows: readonly DicomTagRow[], query: string): DicomTagRow[] {
  const q = query.trim().toLowerCase().replace(/[(),\s]/g, "");
  if (!q) return [...rows];
  return rows.filter((r) => r.tag.toLowerCase().replace(/[(),\s]/g, "").includes(q) || r.name.toLowerCase().replace(/\s/g, "").includes(q) || r.value.toLowerCase().includes(query.trim().toLowerCase()));
}
