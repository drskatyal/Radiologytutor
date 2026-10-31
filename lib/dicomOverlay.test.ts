import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatSigned,
  nextOverlayDensity,
  orientationLetters,
  orientationMarkers,
  overlayCorners,
  parseOverlayDensity,
  windowLine,
} from "./dicomOverlay";

test("density cycles full → basic → off → full and parses junk to full", () => {
  assert.equal(nextOverlayDensity("full"), "basic");
  assert.equal(nextOverlayDensity("basic"), "off");
  assert.equal(nextOverlayDensity("off"), "full");
  assert.equal(parseOverlayDensity("basic"), "basic");
  assert.equal(parseOverlayDensity("nonsense"), "full");
  assert.equal(parseOverlayDensity(null), "full");
});

test("signed numbers use a real minus and never print −0", () => {
  assert.equal(formatSigned(-45.25), "−45.3");
  assert.equal(formatSigned(12), "12.0");
  assert.equal(formatSigned(-0.01), "0.0");
  assert.equal(windowLine(1500, -600), "W 1500  L −600");
  assert.equal(windowLine(undefined, 40), null);
});

test("full overlay puts series top-left, slice top-right, window bottom-left", () => {
  const corners = overlayCorners(
    {
      modality: "ct",
      seriesDescription: "Chest 1.25 Lung",
      seriesNumber: 3,
      sliceThickness: 1.25,
      sliceLocation: -45.25,
      rows: 512,
      columns: 512,
    },
    { slice: 42, count: 240, ww: 1500, wc: -600, zoom: 1.4, presetLabel: "Lung" }
  );
  assert.deepEqual(corners.topLeft, ["Chest 1.25 Lung", "CT  ·  Se 3"]);
  assert.deepEqual(corners.topRight, ["Im 42 / 240", "Th 1.25 mm  Loc −45.3"]);
  assert.deepEqual(corners.bottomLeft, ["W 1500  L −600  Lung"]);
  assert.deepEqual(corners.bottomRight, ["Zoom 140%", "512 × 512"]);
});

test("basic overlay is only slice and window; off is empty", () => {
  const view = { slice: 1, count: 10, ww: 400, wc: 40 };
  const basic = overlayCorners({ seriesDescription: "x" }, view, "basic");
  assert.deepEqual(basic.topLeft, []);
  assert.deepEqual(basic.topRight, ["Im 1 / 10"]);
  assert.deepEqual(basic.bottomLeft, ["W 400  L 40"]);
  const off = overlayCorners({ seriesDescription: "x" }, view, "off");
  assert.equal(
    off.topLeft.length + off.topRight.length + off.bottomLeft.length + off.bottomRight.length,
    0
  );
});

test("MPR plane, inversion and cine show up; missing metadata leaves no blanks", () => {
  const corners = overlayCorners(null, {
    slice: 5,
    count: 9,
    plane: "Axial",
    inverted: true,
    cineFps: 15,
  });
  assert.deepEqual(corners.topLeft, []);
  assert.deepEqual(corners.topRight, ["Axial  Im 5 / 9"]);
  assert.deepEqual(corners.bottomLeft, ["Inverted"]);
  assert.deepEqual(corners.bottomRight, ["Cine 15 fps"]);
});

test("overlay types carry no patient fields even when a header has them", () => {
  const leaky = {
    modality: "MR",
    PatientName: "DOE^JANE",
    patientName: "Jane Doe",
    institutionName: "General Hospital",
  } as unknown as Parameters<typeof overlayCorners>[0];
  const corners = overlayCorners(leaky, { slice: 1, count: 1 });
  const text = JSON.stringify(corners);
  assert.ok(!/doe|jane|hospital/i.test(text), text);
});

test("orientation letters: axial reads R/L and A/P in radiological convention", () => {
  assert.deepEqual(orientationMarkers([1, 0, 0, 0, 1, 0]), {
    right: "L",
    left: "R",
    bottom: "P",
    top: "A",
  });
});

test("orientation letters: coronal and sagittal", () => {
  assert.deepEqual(orientationMarkers([1, 0, 0, 0, 0, -1]), {
    right: "L",
    left: "R",
    bottom: "F",
    top: "H",
  });
  assert.deepEqual(orientationMarkers([0, 1, 0, 0, 0, -1]), {
    right: "P",
    left: "A",
    bottom: "F",
    top: "H",
  });
});

test("oblique planes name a second axis; header noise does not", () => {
  assert.equal(orientationLetters([0.9998, 0.02, 0]), "L");
  assert.equal(orientationLetters([0.7071, 0.7071, 0]), "LP");
  assert.equal(orientationLetters([-0.8, 0, 0.6]), "RH");
});

test("no orientation → no markers", () => {
  assert.equal(orientationMarkers(null), null);
  assert.equal(orientationMarkers([1, 0, 0]), null);
  assert.equal(orientationMarkers([NaN, 0, 0, 0, 1, 0]), null);
  assert.equal(orientationMarkers([0, 0, 0, 0, 0, 0]), null);
});
