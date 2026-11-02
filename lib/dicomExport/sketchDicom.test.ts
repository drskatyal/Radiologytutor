import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSketchSrDataset,
  exportSketchGsps,
  exportSketchSr,
  readSketchGsps,
  readSketchSr,
  SOP_CLASS,
  TRACKING_PREFIX,
  type SketchExportContext,
} from "./sketchDicom.ts";
import { buildSketchSidecar, SIDECAR_SCHEMA } from "./sketchSidecar.ts";
import { anchorPoint, imageRefFrom } from "../teacherSketch.ts";
import { indexToPatient, patientToIndex, type DicomImagePlane, type SketchFrameImage } from "../sketchProjection.ts";
import type { RecordedEvent, TeacherSketchItem } from "../types.ts";

const PLANE: DicomImagePlane = {
  imagePositionPatient: [-175.2, -180.6, -210.5],
  rowCosines: [1, 0, 0],
  columnCosines: [0, 1, 0],
  pixelSpacing: [0.703125, 0.703125],
  columns: 512,
  rows: 512,
};

const OBLIQUE: DicomImagePlane = {
  imagePositionPatient: [10, -20, 30],
  rowCosines: [Math.cos(0.4), 0, -Math.sin(0.4)],
  columnCosines: [0, 1, 0],
  pixelSpacing: [0.9, 0.6],
  columns: 320,
  rows: 256,
};

function image(slice: number, plane = PLANE, extra: Partial<SketchFrameImage> = {}): SketchFrameImage {
  return {
    sliceIndex: slice,
    studyInstanceUID: "1.2.826.0.1.3680043.8.498.1",
    seriesInstanceUID: "1.2.826.0.1.3680043.8.498.2",
    sopInstanceUID: `1.2.826.0.1.3680043.8.498.3.${slice}`,
    sopClassUID: SOP_CLASS.ctImage,
    frameOfReferenceUID: "1.2.826.0.1.3680043.8.498.9",
    columns: plane.columns,
    rows: plane.rows,
    plane,
    ...extra,
  };
}

function item(id: string, kind: TeacherSketchItem["kind"], pts: Array<[number, number]>, img = image(6), extra: Partial<TeacherSketchItem> = {}): TeacherSketchItem {
  return {
    id,
    kind,
    image: imageRefFrom(img, img.sliceIndex),
    points: pts.map(([x, y], i) => anchorPoint(x, y, img, i * 40)),
    ...extra,
  };
}

const CTX: SketchExportContext = {
  studyInstanceUID: "1.2.826.0.1.3680043.8.498.1",
  patientName: "ANON^CASE",
  patientID: "ANON-001",
  studyDate: "20240101",
  frameOfReferenceUID: "1.2.826.0.1.3680043.8.498.9",
};

const ITEMS: TeacherSketchItem[] = [
  item("pen-1", "pen", [[0.1, 0.2], [0.15, 0.22], [0.2, 0.27], [0.24, 0.31]], image(6), { drawMs: 120 }),
  item("arrow-1", "arrow", [[0.8, 0.7], [0.6, 0.45]]),
  item("ellipse-1", "ellipse", [[0.55, 0.3], [0.71, 0.4]], image(7, OBLIQUE)),
  item("text-1", "text", [[0.3, 0.8]], image(6), { text: "Air bronchogram" }),
  item("marker-1", "marker", [[0.62, 0.37]], image(6), { number: 1, text: "Spiculated nodule" }),
];

test("SR round-trip: every stroke comes back on its SOP at the same pixel, in SCOORD and SCOORD3D", () => {
  const out = exportSketchSr(ITEMS, CTX, { timing: { tMs: { "marker-1": 3100 } } });
  assert.deepEqual(out.written, ITEMS.map((i) => i.id));
  assert.deepEqual(out.skipped, []);
  const { dataset, groups } = readSketchSr(out.bytes);
  assert.equal(dataset.SOPClassUID, SOP_CLASS.comprehensive3dSr);
  assert.equal(dataset.Modality, "SR");
  assert.equal(dataset.StudyInstanceUID, CTX.studyInstanceUID);
  assert.equal(dataset.SOPInstanceUID, out.sopInstanceUID);
  assert.equal((dataset.ContentTemplateSequence as Array<{ TemplateIdentifier: string }>)[0]!.TemplateIdentifier, "1500");
  assert.equal(groups.length, ITEMS.length);

  for (const src of ITEMS) {
    const g = groups.find((x) => x.itemId === src.id)!;
    assert.ok(g, src.id);
    assert.equal(g.trackingId, `${TRACKING_PREFIX}:${src.kind}:${src.id}`);
    assert.equal(g.trackingUid, out.trackingUids[src.id]);
    assert.equal(g.sopInstanceUID, src.image.sopInstanceUID);
    if (src.kind === "pen" || src.kind === "arrow") {
      assert.equal(g.graphicType, "POLYLINE");
      assert.equal(g.idx.length, src.points.length);
      src.points.forEach((p, i) => {
        assert.ok(Math.abs(g.idx[i]!.col - p.col!) < 1e-3, `${src.id} col ${i}`);
        assert.ok(Math.abs(g.idx[i]!.row - p.row!) < 1e-3, `${src.id} row ${i}`);
        // SCOORD3D carries the same point in patient mm.
        g.mm![i]!.forEach((v, axis) => assert.ok(Math.abs(v - p.mm![axis]!) < 1e-3));
      });
    } else if (src.kind === "ellipse") {
      assert.equal(g.graphicType, "ELLIPSE");
      assert.equal(g.idx.length, 4);
      const [a, b] = [src.points[0]!, src.points[1]!];
      // Major axis is horizontal here: endpoints sit on the box's left/right edges.
      assert.ok(Math.abs(g.idx[0]!.col - Math.min(a.col!, b.col!)) < 1e-3);
      assert.ok(Math.abs(g.idx[1]!.col - Math.max(a.col!, b.col!)) < 1e-3);
      assert.ok(Math.abs(g.idx[0]!.row - (a.row! + b.row!) / 2) < 1e-3);
      // SCOORD3D ellipse = the same four endpoints mapped through the oblique plane.
      g.idx.forEach((p, i) => {
        const mm = indexToPatient(p.col, p.row, OBLIQUE)!;
        mm.forEach((v, axis) => assert.ok(Math.abs(v - g.mm![i]![axis]!) < 1e-3));
        const back = patientToIndex(g.mm![i] as [number, number, number], OBLIQUE)!;
        assert.ok(Math.abs(back.col - p.col) < 1e-3 && Math.abs(back.row - p.row) < 1e-3);
      });
    } else {
      assert.equal(g.graphicType, "POINT");
      assert.ok(Math.abs(g.idx[0]!.col - src.points[0]!.col!) < 1e-3);
    }
    assert.equal(g.frameOfReferenceUID, CTX.frameOfReferenceUID);
  }
  const marker = groups.find((g) => g.itemId === "marker-1")!;
  assert.equal(marker.label, "#1 Spiculated nodule");
  assert.equal(marker.tMs, 3100);
  assert.equal(groups.find((g) => g.itemId === "text-1")!.text, "Air bronchogram");
});

test("SR is shaped the way OHIF's dicom-sr reader walks it", () => {
  const { dataset } = buildSketchSrDataset(ITEMS, CTX);
  const root = dataset.ContentSequence as Array<Record<string, unknown>>;
  const name = (c: Record<string, unknown>) => (c.ConceptNameCodeSequence as Array<{ CodeValue: string }>)[0]!.CodeValue;
  const measurements = root.find((c) => name(c) === "126010")!;
  const groups = measurements.ContentSequence as Array<Record<string, unknown>>;
  for (const group of groups) {
    assert.equal(name(group), "125007");
    const content = group.ContentSequence as Array<Record<string, unknown>>;
    assert.ok(content.some((c) => name(c) === "112039" && c.ValueType === "TEXT"));
    assert.ok(content.some((c) => name(c) === "112040" && c.ValueType === "UIDREF"));
    const scoord = content.find((c) => c.ValueType === "SCOORD")!;
    const selected = (scoord.ContentSequence as Array<Record<string, unknown>>)[0]!;
    assert.equal(selected.RelationshipType, "SELECTED FROM");
    assert.equal(selected.ValueType, "IMAGE");
  }
  const library = root.find((c) => name(c) === "111028")!;
  const images = ((library.ContentSequence as Array<Record<string, unknown>>)[0]!.ContentSequence as unknown[]).length;
  assert.equal(images, 2, "two distinct referenced images (slice 6, slice 7)");
  const evidence = dataset.CurrentRequestedProcedureEvidenceSequence as Array<{ StudyInstanceUID: string }>;
  assert.equal(evidence[0]!.StudyInstanceUID, CTX.studyInstanceUID);
});

test("marks without a DICOM image are skipped with a reason, never exported against the wrong pixels", () => {
  const sample = item("pen-sample", "pen", [[0.1, 0.1], [0.2, 0.2]], { sliceIndex: 2 });
  const other = item("pen-other", "pen", [[0.1, 0.1], [0.2, 0.2]], image(6, PLANE, { studyInstanceUID: "9.9.9" }));
  const out = exportSketchSr([sample, other, ITEMS[1]!], CTX);
  assert.deepEqual(out.written, ["arrow-1"]);
  assert.deepEqual(out.skipped.map((s) => s.id), ["pen-sample", "pen-other"]);
});

test("multi-frame marks reference their frame number", () => {
  const frameItem = item("m-frame", "marker", [[0.5, 0.5]], image(3, PLANE, { frameNumber: 4, sopInstanceUID: "1.2.3.44" }), { number: 2, text: "Frame mark" });
  const { groups } = readSketchSr(exportSketchSr([frameItem], CTX).bytes);
  assert.equal(groups[0]!.frameNumber, 4);
  assert.equal(groups[0]!.sopInstanceUID, "1.2.3.44");
});

test("GSPS round-trip: graphics on the FLOWRAD_SKETCH layer per referenced image, labels as text", () => {
  const out = exportSketchGsps(ITEMS, CTX);
  const ds = readSketchGsps(out.bytes);
  assert.equal(ds.SOPClassUID, SOP_CLASS.gsps);
  assert.equal(ds.Modality, "PR");
  assert.equal(ds.PresentationLUTShape, "IDENTITY");
  const annotations = ds.GraphicAnnotationSequence as Array<Record<string, unknown>>;
  assert.equal(annotations.length, 2);
  const slice6 = annotations.find(
    (a) => (a.ReferencedImageSequence as Array<{ ReferencedSOPInstanceUID: string }>)[0]!.ReferencedSOPInstanceUID.endsWith(".6")
  )!;
  const graphics = slice6.GraphicObjectSequence as Array<{ GraphicType: string; GraphicData: number[]; GraphicAnnotationUnits: string }>;
  // pen (1) + arrow shaft and two head ticks (3) + text point + marker point.
  assert.equal(graphics.length, 6);
  assert.ok(graphics.every((g) => g.GraphicAnnotationUnits === "PIXEL"));
  const penData = graphics[0]!.GraphicData;
  assert.ok(Math.abs(penData[0]! - (ITEMS[0]!.points[0]!.col! + 0.5)) < 1e-3);
  const texts = (slice6.TextObjectSequence as Array<{ UnformattedTextValue: string }>).map((t) => t.UnformattedTextValue);
  assert.deepEqual(texts.sort(), ["#1 Spiculated nodule", "Air bronchogram"]);
});

test("JSON sidecar keeps timing, per-point dt and the sentence each mark was drawn under", () => {
  const events: RecordedEvent[] = [
    { t: 1000, type: "sketch", op: "add", item: ITEMS[0]! },
    { t: 3100, type: "sketch", op: "add", item: { ...ITEMS[4]!, text: "Finding 1" } },
    { t: 3600, type: "sketch", op: "label", id: "marker-1", text: "Spiculated nodule" },
  ];
  const sidecar = buildSketchSidecar({
    caseId: "case-1",
    items: [ITEMS[0]!, ITEMS[4]!],
    events,
    narration: [{ tStartMs: 2800, tEndMs: 5000, text: "There is a spiculated nodule." }],
    durationMs: 6000,
    trackingUids: { "marker-1": "2.25.1" },
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(sidecar.schema, SIDECAR_SCHEMA);
  const m = sidecar.items.find((i) => i.id === "marker-1")!;
  assert.equal(m.timeline?.tMs, 3100);
  assert.equal(m.timeline?.label, "Spiculated nodule");
  assert.equal(m.timeline?.said, "There is a spiculated nodule.");
  assert.equal(m.trackingUid, "2.25.1");
  assert.equal(sidecar.items[0]!.points[1]!.dt, 40);
  assert.equal(JSON.parse(JSON.stringify(sidecar)).items.length, 2);
});
