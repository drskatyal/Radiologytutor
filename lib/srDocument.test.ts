import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import dicomParser from "dicom-parser";
import {
  documentFromDataSet,
  groupLocalStudies,
  isStructuredDocumentClass,
  reportsForStudy,
  withKeyImageSeries,
  type DicomDocument,
  type LocalInstanceHeader,
  type SrDataSet,
} from "@flowrad/viewer-core";

/** A minimal stand-in for dicom-parser's DataSet. */
function ds(values: Record<string, string>, sequences: Record<string, SrDataSet[]> = {}): SrDataSet {
  const elements: SrDataSet["elements"] = {};
  for (const [tag, list] of Object.entries(sequences)) elements[tag] = { items: list.map((d) => ({ dataSet: d })) };
  return { string: (tag) => values[tag], elements };
}
const code = (meaning: string, value = "X") => ds({ x00080104: meaning, x00080100: value });

test("SR content tree flattens like the desktop reader (TEXT, CODE, NUM+unit, PNAME, IMAGE)", () => {
  const image = ds({ x0040a040: "IMAGE" }, { x00081199: [ds({ x00081155: "1.2.3.4" })] });
  const group = ds(
    { x0040a040: "CONTAINER" },
    {
      x0040a043: [code("Measurement Group")],
      x0040a730: [
        ds({ x0040a040: "TEXT", x0040a160: "Right lower lobe nodule, solid." }, { x0040a043: [code("Finding")] }),
        ds(
          { x0040a040: "NUM" },
          { x0040a043: [code("Length")], x0040a300: [ds({ x0040a30a: "12.4" }, { x004008ea: [code("millimeter", "mm")] })] }
        ),
        ds({ x0040a040: "CODE" }, { x0040a043: [code("Finding Site")], x0040a168: [code("Lower lobe of right lung")] }),
        ds({ x0040a040: "PNAME", x0040a123: "DOE^JANE" }, { x0040a043: [code("Observer")] }),
        image,
      ],
    }
  );
  const root = ds(
    { x00080016: "1.2.840.10008.5.1.4.1.1.88.33", x00080018: "9.9", x0020000d: "1.2", x00080023: "20240115" },
    { x0040a043: [code("Imaging Measurement Report")], x0040a730: [group] }
  );
  const doc = documentFromDataSet(root, "SR.dcm")!;
  assert.equal(doc.kind, "sr");
  assert.equal(doc.title, "Imaging Measurement Report");
  assert.equal(doc.date, "20240115");
  assert.deepEqual(doc.lines, [
    "Measurement Group",
    "  Finding: Right lower lobe nodule, solid.",
    "  Length: 12.4 mm",
    "  Finding Site: Lower lobe of right lung",
    "  Observer: DOE JANE",
  ]);
  assert.deepEqual(doc.references, ["1.2.3.4"]);
});

test("only SR-family SOP classes are documents; KO is a key-image note", () => {
  assert.equal(isStructuredDocumentClass("1.2.840.10008.5.1.4.1.1.2"), false);
  assert.equal(isStructuredDocumentClass("1.2.840.10008.5.1.4.1.1.88.59"), true);
  assert.equal(documentFromDataSet(ds({ x00080016: "1.2.840.10008.5.1.4.1.1.2" }), "CT.dcm"), null);
  const ko = documentFromDataSet(ds({ x00080016: "1.2.840.10008.5.1.4.1.1.88.59" }), "KO.dcm")!;
  assert.equal(ko.kind, "ko");
  assert.equal(ko.title, "Key images");
});

test("a key-image note becomes a KO series of exactly its images, in note order", () => {
  const ct = (n: number): LocalInstanceHeader => ({
    fileName: `IM${n}`,
    sizeBytes: 1,
    studyInstanceUID: "1.2",
    seriesInstanceUID: "1.2.3",
    sopInstanceUID: `sop.${n}`,
    instanceNumber: n,
    modality: "CT",
    imagePositionPatient: [0, 0, -n],
    imageOrientationPatient: [1, 0, 0, 0, 1, 0],
  });
  const studies = groupLocalStudies([ct(1), ct(2), ct(3)]);
  const note: DicomDocument = {
    kind: "ko",
    fileName: "KO",
    studyInstanceUid: "1.2",
    sopInstanceUid: "ko.1",
    title: "Of Interest",
    lines: [],
    references: ["sop.3", "missing", "sop.1"],
  };
  const report: DicomDocument = { ...note, kind: "sr", sopInstanceUid: "sr.1", title: "Report", references: [] };
  const [study] = withKeyImageSeries(studies, [note, report, { ...note, studyInstanceUid: "other" }]);
  assert.equal(study.series.length, 2);
  const ko = study.series[0];
  assert.equal(ko.modality, "KO");
  assert.equal(ko.description, "Key images · Of Interest");
  assert.deepEqual(ko.instances.map((i) => i.sopInstanceUID), ["sop.3", "sop.1"]);
  assert.equal(ko.imageCount, 2);
  assert.equal(withKeyImageSeries(studies, [report]), studies, "no notes: unchanged");
  assert.deepEqual(reportsForStudy("1.2", [note, report]), [report]);
});

// Same fixtures the Rust reader is tested on (desktop/scripts/make-fixtures.py).
test("reads the SR and KO fixtures the same way the desktop shell does", { skip: !process.env.RADLEARN_FIXTURES }, () => {
  const dir = path.join(process.env.RADLEARN_FIXTURES!, "documents");
  const read = (f: string) =>
    documentFromDataSet(dicomParser.parseDicom(new Uint8Array(fs.readFileSync(path.join(dir, f)))) as unknown as SrDataSet, f)!;
  const sr = read("SR_measurements.dcm");
  assert.equal(sr.kind, "sr");
  assert.equal(sr.title, "Imaging Measurement Report");
  assert.ok(sr.lines.some((l) => l.trim() === "Finding: Right lower lobe nodule, solid."), sr.lines.join("\n"));
  assert.ok(sr.lines.some((l) => l.trim() === "Length: 12.4 mm"));
  assert.ok(sr.lines.some((l) => l.trim() === "Finding Site: Lower lobe of right lung"));
  assert.equal(sr.references.length, 1);
  const ko = read("KO_key_images.dcm");
  assert.equal(ko.kind, "ko");
  assert.equal(ko.references.length, 2);
  assert.ok(ko.lines.some((l) => l.includes("Nodule and adjacent slice.")));
});
