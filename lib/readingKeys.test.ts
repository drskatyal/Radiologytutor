import { test } from "node:test";
import assert from "node:assert/strict";
import { isFullScreenKey, openKeyOf, pageStep, parallelScaleForPixelZoom, resolveReadingKey, zoomLevelLabel } from "@flowrad/viewer-core/readingKeys";

test("reading keys: Ctrl/⌘+0…4 zoom to fit, 100, 200, 400, 800 %", () => {
  assert.deepEqual(resolveReadingKey({ key: "0", ctrlKey: true }), { type: "zoomTo", scale: "fit" });
  assert.deepEqual(resolveReadingKey({ key: "1", metaKey: true }), { type: "zoomTo", scale: 1 });
  assert.deepEqual(resolveReadingKey({ key: "2", ctrlKey: true }), { type: "zoomTo", scale: 2 });
  assert.deepEqual(resolveReadingKey({ key: "3", ctrlKey: true }), { type: "zoomTo", scale: 4 });
  assert.deepEqual(resolveReadingKey({ key: "4", ctrlKey: true }), { type: "zoomTo", scale: 8 });
  // A layout where the digit row is shifted (AZERTY): the code says which key.
  assert.deepEqual(resolveReadingKey({ key: "é", code: "Digit2", ctrlKey: true }), { type: "zoomTo", scale: 2 });
  assert.equal(resolveReadingKey({ key: "5", ctrlKey: true }), null);
  // Bare digits stay window presets; Shift / Alt digits are not ours.
  assert.equal(resolveReadingKey({ key: "1" }), null);
  assert.equal(resolveReadingKey({ key: "1", ctrlKey: true, shiftKey: true }), null);
  assert.equal(resolveReadingKey({ key: "1", ctrlKey: true, altKey: true }), null);
});

test("reading keys: Ctrl/⌘+arrows pan; bare arrows stay slice keys", () => {
  assert.deepEqual(resolveReadingKey({ key: "ArrowLeft", ctrlKey: true }), { type: "pan", dx: -40, dy: 0 });
  assert.deepEqual(resolveReadingKey({ key: "ArrowRight", metaKey: true }), { type: "pan", dx: 40, dy: 0 });
  assert.deepEqual(resolveReadingKey({ key: "ArrowUp", ctrlKey: true }), { type: "pan", dx: 0, dy: -40 });
  assert.deepEqual(resolveReadingKey({ key: "ArrowDown", ctrlKey: true }), { type: "pan", dx: 0, dy: 40 });
  assert.equal(resolveReadingKey({ key: "ArrowDown" }), null);
  assert.deepEqual(resolveReadingKey({ key: "ArrowDown", shiftKey: true }), { type: "slicePage", dir: 1 });
});

test("reading keys: F12 annotations, Ctrl/⌘+F12 reference lines, F5 family links", () => {
  assert.deepEqual(resolveReadingKey({ key: "F12" }), { type: "annotations" });
  assert.deepEqual(resolveReadingKey({ key: "F12", ctrlKey: true }), { type: "referenceLines" });
  assert.deepEqual(resolveReadingKey({ key: "F12", ctrlKey: true, shiftKey: true }), { type: "overlay" });
  assert.deepEqual(resolveReadingKey({ key: "F5" }), { type: "link", what: "scroll" });
  assert.deepEqual(resolveReadingKey({ key: "F5", shiftKey: true }), { type: "link", what: "voi" });
  assert.deepEqual(resolveReadingKey({ key: "F5", altKey: true }), { type: "link", what: "zoom" });
  assert.equal(resolveReadingKey({ key: "F5", ctrlKey: true }), null);
  assert.equal(resolveReadingKey({ key: "F5", shiftKey: true, altKey: true }), null);
});

test("reading keys: 100 % is one image row per screen pixel", () => {
  // 512 CSS px tall pane, 0.7 mm rows: 100 % shows 512 rows = 358.4 mm, half is 179.2.
  assert.equal(parallelScaleForPixelZoom(512, 0.7, 1), 179.2);
  assert.equal(parallelScaleForPixelZoom(512, 0.7, 2), 89.6);
  assert.equal(parallelScaleForPixelZoom(0, 0.7, 1), null);
  assert.equal(parallelScaleForPixelZoom(512, 0, 1), null);
  assert.equal(parallelScaleForPixelZoom(512, 0.7, Number.NaN), null);
  assert.equal(zoomLevelLabel("fit"), "Fit to the pane");
  assert.equal(zoomLevelLabel(4), "Zoom 400 %");
});

test("reading keys: Alt+A / C / S reformat (by physical key: å ç ß on a Mac), Shift+E eraser, Ctrl/⌘+Shift+Backspace clears", () => {
  assert.deepEqual(resolveReadingKey({ key: "c", code: "KeyC", altKey: true }), { type: "reformat", plane: "coronal" });
  assert.deepEqual(resolveReadingKey({ key: "ß", code: "KeyS", altKey: true }), { type: "reformat", plane: "sagittal" });
  assert.deepEqual(resolveReadingKey({ key: "å", code: "KeyA", altKey: true }), { type: "reformat", plane: "axial" });
  assert.equal(resolveReadingKey({ key: "x", code: "KeyX", altKey: true }), null);
  assert.equal(resolveReadingKey({ key: "c", code: "KeyC", altKey: true, ctrlKey: true }), null);
  assert.deepEqual(resolveReadingKey({ key: "E", code: "KeyE", shiftKey: true }), { type: "eraser" });
  assert.equal(resolveReadingKey({ key: "e", code: "KeyE" }), null, "bare E stays the ellipse");
  assert.deepEqual(resolveReadingKey({ key: "Backspace", ctrlKey: true, shiftKey: true }), { type: "clearMeasurements" });
  assert.deepEqual(resolveReadingKey({ key: "Delete", metaKey: true, shiftKey: true }), { type: "clearMeasurements" });
  assert.equal(resolveReadingKey({ key: "Backspace", ctrlKey: true }), null);
});

test("reading keys: Space cine, Shift+[ / ] cine speed, [ / ] series, Ctrl/⌘+M MPR, Ctrl/⌘+Shift+M 3D, Ctrl/⌘+Shift+F12 overlay, F full screen", () => {
  assert.deepEqual(resolveReadingKey({ key: " ", code: "Space" }), { type: "cine" });
  assert.equal(resolveReadingKey({ key: " ", code: "Space", shiftKey: true }), null);
  assert.deepEqual(resolveReadingKey({ key: "{", code: "BracketLeft", shiftKey: true }), { type: "cineFps", delta: -1 });
  assert.deepEqual(resolveReadingKey({ key: "}", code: "BracketRight", shiftKey: true }), { type: "cineFps", delta: 1 });
  assert.deepEqual(resolveReadingKey({ key: "[", code: "BracketLeft" }), { type: "series", delta: -1 });
  assert.deepEqual(resolveReadingKey({ key: "]", code: "BracketRight" }), { type: "series", delta: 1 });
  assert.equal(resolveReadingKey({ key: "]", ctrlKey: true }), null, "Ctrl/⌘+] stays the slab key");
  assert.deepEqual(resolveReadingKey({ key: "m", code: "KeyM", ctrlKey: true }), { type: "mpr" });
  assert.deepEqual(resolveReadingKey({ key: "M", code: "KeyM", metaKey: true, shiftKey: true }), { type: "volume3d" });
  assert.equal(resolveReadingKey({ key: "m", code: "KeyM" }), null, "bare M stays the pan tool");
  assert.deepEqual(resolveReadingKey({ key: "F12", ctrlKey: true, shiftKey: true }), { type: "overlay" });
  assert.equal(isFullScreenKey({ key: "f", code: "KeyF" }), true);
  assert.equal(isFullScreenKey({ key: "f", code: "KeyF", ctrlKey: true }), false);
  assert.equal(isFullScreenKey({ key: "F", code: "KeyF", shiftKey: true }), false, "Ctrl/⌘+Shift+F is fusion; Shift+F nothing");
});

test("reading keys: PageUp / PageDown and Shift+↑ / ↓ jump 10 % of the images, as on the desktop", () => {
  assert.deepEqual(resolveReadingKey({ key: "PageDown" }), { type: "slicePage", dir: 1 });
  assert.deepEqual(resolveReadingKey({ key: "PageUp" }), { type: "slicePage", dir: -1 });
  assert.deepEqual(resolveReadingKey({ key: "ArrowDown", shiftKey: true }), { type: "slicePage", dir: 1 });
  assert.deepEqual(resolveReadingKey({ key: "ArrowUp", shiftKey: true }), { type: "slicePage", dir: -1 });
  assert.equal(resolveReadingKey({ key: "ArrowDown" }), null, "a bare arrow is still one slice");
  assert.equal(resolveReadingKey({ key: "PageDown", ctrlKey: true }), null);
  assert.deepEqual([pageStep(60), pageStep(520), pageStep(4), pageStep(0)], [6, 52, 1, 1]);
});

test("reading keys: Shift+Backspace resets rotation and flips only; bare Backspace stays the full reset", () => {
  assert.deepEqual(resolveReadingKey({ key: "Backspace", shiftKey: true }), { type: "orientReset" });
  assert.equal(resolveReadingKey({ key: "Backspace" }), null);
  assert.deepEqual(resolveReadingKey({ key: "Backspace", ctrlKey: true, shiftKey: true }), { type: "clearMeasurements" });
});

test("reading keys: Y arrow, N freehand ROI, Q / Shift+Q rotate (the desktop's letters)", () => {
  assert.deepEqual(resolveReadingKey({ key: "y", code: "KeyY" }), { type: "tool", tool: "ArrowAnnotate" });
  assert.deepEqual(resolveReadingKey({ key: "n", code: "KeyN" }), { type: "tool", tool: "PlanarFreehandROI" });
  assert.deepEqual(resolveReadingKey({ key: "q", code: "KeyQ" }), { type: "rotate", dir: 1 });
  assert.deepEqual(resolveReadingKey({ key: "Q", code: "KeyQ", shiftKey: true }), { type: "rotate", dir: -1 });
  assert.equal(resolveReadingKey({ key: "y", code: "KeyY", ctrlKey: true }), null, "Ctrl/⌘+Y stays redo");
  assert.equal(resolveReadingKey({ key: "N", code: "KeyN", shiftKey: true }), null);
  // A QWERTZ keyboard: the key labelled Y sits where QWERTY has Z (code KeyZ, key "y"): the letter typed wins, as on the desktop.
  assert.deepEqual(resolveReadingKey({ key: "y", code: "KeyZ" }), { type: "tool", tool: "ArrowAnnotate" });
  assert.equal(resolveReadingKey({ key: "z", code: "KeyY" }), null);
});

test("reading keys: Shift+1…7 pick the desktop's layouts (by physical key); Shift+8 / 9 stay presets", () => {
  assert.deepEqual(resolveReadingKey({ key: "!", code: "Digit1", shiftKey: true }), { type: "layout", n: 1 });
  assert.deepEqual(resolveReadingKey({ key: "&", code: "Digit7", shiftKey: true }), { type: "layout", n: 7 });
  assert.equal(resolveReadingKey({ key: "*", code: "Digit8", shiftKey: true }), null);
  assert.equal(resolveReadingKey({ key: "1", code: "Digit1" }), null, "a bare digit is still a window preset");
});

test("open keys: Ctrl/⌘+O files, Ctrl/⌘+Shift+O a folder (by physical key too); nothing else", () => {
  assert.equal(openKeyOf({ key: "o", code: "KeyO", ctrlKey: true }), "files");
  assert.equal(openKeyOf({ key: "o", code: "KeyO", metaKey: true }), "files");
  assert.equal(openKeyOf({ key: "O", code: "KeyO", ctrlKey: true, shiftKey: true }), "folder");
  assert.equal(openKeyOf({ key: "ø", code: "KeyO", metaKey: true }), "files", "a layout that types another letter");
  assert.equal(openKeyOf({ key: "o", code: "KeyO" }), null, "a bare O stays the overlay key");
  assert.equal(openKeyOf({ key: "o", code: "KeyO", ctrlKey: true, altKey: true }), null);
  assert.equal(openKeyOf({ key: "p", code: "KeyP", ctrlKey: true }), null);
  // The open keys are not reading keys: the image never sees them as anything.
  assert.equal(resolveReadingKey({ key: "o", code: "KeyO", ctrlKey: true }), null);
});
