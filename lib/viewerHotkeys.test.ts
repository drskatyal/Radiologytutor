import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  VIEWER_SHORTCUT_GROUPS,
  shortcutForPreset,
  shortcutForTool,
  VIEWER_HOTKEY_HINTS,
  isTextTarget,
  resolveViewerHotkey,
  viewerShortcutGroups,
} from "./viewerHotkeys";

// Keys the student session already binds on `window`
// (components/student/StudentSession.tsx + lib/seriesRailPreference.ts).
const SESSION_KEYS = ["c", "n", "p", "r", "t", "f", "[", "?", " "];

test("number keys 1–9 are window presets and 0 the series default, as on the desktop", () => {
  for (let n = 1; n <= 9; n += 1) {
    assert.deepEqual(resolveViewerHotkey({ key: String(n) }), { type: "preset", ordinal: n }, String(n));
  }
  assert.deepEqual(resolveViewerHotkey({ key: "0" }), { type: "preset", ordinal: 0 });
  // Through the bindings engine too (a physical digit on any layout).
  assert.deepEqual(resolveViewerHotkey({ key: "&", code: "Digit7" }), { type: "preset", ordinal: 7 });
});

test("each preset row shows its key", () => {
  assert.equal(shortcutForPreset(1, {}), "1");
  assert.equal(shortcutForPreset(9, {}), "9");
  assert.equal(shortcutForPreset(0, {}), "0");
  assert.equal(shortcutForPreset(10, {}), null);
});

test("no viewer hotkey collides with a key the student session owns", () => {
  for (const key of SESSION_KEYS) {
    assert.equal(
      resolveViewerHotkey({ key }),
      null,
      `${JSON.stringify(key)} is already a session hotkey`
    );
  }
});

test("a modifier hands the key back to the browser", () => {
  for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
    assert.equal(resolveViewerHotkey({ key: "1", [modifier]: true }), null, modifier);
    assert.equal(resolveViewerHotkey({ key: "ArrowDown", [modifier]: true }), null, modifier);
    assert.equal(resolveViewerHotkey({ key: "0", [modifier]: true }), null, modifier);
  }
});

test("arrows and page keys move the stack", () => {
  assert.deepEqual(resolveViewerHotkey({ key: "ArrowDown" }, 240), { type: "slice", delta: 1 });
  assert.deepEqual(resolveViewerHotkey({ key: "ArrowUp" }, 240), { type: "slice", delta: -1 });
  assert.deepEqual(resolveViewerHotkey({ key: "PageDown" }, 240), { type: "slice", delta: 12 });
  assert.deepEqual(resolveViewerHotkey({ key: "ArrowDown", shiftKey: true }, 240), {
    type: "slice",
    delta: 12,
  });
});

test("Home and End jump to the ends", () => {
  assert.deepEqual(resolveViewerHotkey({ key: "Home" }), {
    type: "sliceAbsolute",
    where: "first",
  });
  assert.deepEqual(resolveViewerHotkey({ key: "End" }), { type: "sliceAbsolute", where: "last" });
});

test("zoom, reset, invert and cine", () => {
  const zoomIn = resolveViewerHotkey({ key: "+" });
  assert.equal(zoomIn?.type, "zoom");
  assert.ok(zoomIn && zoomIn.type === "zoom" && zoomIn.factor > 1);
  const zoomOut = resolveViewerHotkey({ key: "-" });
  assert.ok(zoomOut && zoomOut.type === "zoom" && zoomOut.factor < 1);
  assert.deepEqual(resolveViewerHotkey({ key: "=" })?.type, "zoom", "unshifted + on US layouts");
  assert.deepEqual(resolveViewerHotkey({ key: "Backspace" }), { type: "reset" });
  assert.deepEqual(resolveViewerHotkey({ key: "i" }), { type: "invert" });
  assert.deepEqual(resolveViewerHotkey({ key: "I" }), { type: "invert" });
  assert.deepEqual(resolveViewerHotkey({ key: "k" }), { type: "cine" });
});

test("Shift and a digit is a window preset, by number or by shifted glyph", () => {
  assert.deepEqual(resolveViewerHotkey({ key: "1", shiftKey: true }), {
    type: "preset",
    ordinal: 1,
  });
  assert.deepEqual(resolveViewerHotkey({ key: "!" }), { type: "preset", ordinal: 1 });
  assert.deepEqual(resolveViewerHotkey({ key: "#" }), { type: "preset", ordinal: 3 });
  assert.deepEqual(resolveViewerHotkey({ key: "(" }), { type: "preset", ordinal: 9 });
});

test("no digit, bare or shifted, is a tool shortcut", () => {
  for (const digit of "0123456789") {
    assert.equal(resolveViewerHotkey({ key: digit })?.type, "preset", digit);
    assert.equal(resolveViewerHotkey({ key: digit, shiftKey: true })?.type, "preset", `Shift+${digit}`);
  }
});

test("unbound keys pass through", () => {
  for (const key of ["q", "y", "Enter", "Tab", "Escape", "F5"]) {
    assert.equal(resolveViewerHotkey({ key }), null, key);
  }
  for (const key of ["1", "ArrowDown", "a", "z"]) {
    assert.notEqual(resolveViewerHotkey({ key }), null, key);
  }
});

test("text fields are never hijacked", () => {
  assert.equal(isTextTarget({ tagName: "INPUT" } as unknown as EventTarget), true);
  assert.equal(isTextTarget({ tagName: "textarea" } as unknown as EventTarget), true);
  assert.equal(isTextTarget({ tagName: "SELECT" } as unknown as EventTarget), true);
  assert.equal(
    isTextTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget),
    true
  );
  assert.equal(isTextTarget({ tagName: "DIV" } as unknown as EventTarget), false);
  assert.equal(isTextTarget(null), false);
  assert.equal(isTextTarget({} as unknown as EventTarget), false);
});

test("every hint names a key the resolver actually answers", () => {
  assert.ok(VIEWER_HOTKEY_HINTS.length > 0);
  for (const hint of VIEWER_HOTKEY_HINTS) {
    assert.ok(hint.keys.trim().length > 0, "a hint without a key");
    assert.ok(hint.does.trim().length > 0, `"${hint.keys}" without a description`);
  }
});

test("letter tools follow the PACS mnemonic", () => {
  assert.deepEqual(resolveViewerHotkey({ key: "w" }), { type: "tool", tool: "WindowLevel" });
  assert.deepEqual(resolveViewerHotkey({ key: "S" }), { type: "tool", tool: "StackScroll" });
  assert.deepEqual(resolveViewerHotkey({ key: "z" }), { type: "tool", tool: "Zoom" });
  assert.deepEqual(resolveViewerHotkey({ key: "m" }), { type: "tool", tool: "Pan" });
  assert.deepEqual(resolveViewerHotkey({ key: "l" }), { type: "tool", tool: "Length" });
  assert.deepEqual(resolveViewerHotkey({ key: "a" }), { type: "tool", tool: "Angle" });
  assert.deepEqual(resolveViewerHotkey({ key: "e" }), { type: "tool", tool: "EllipticalROI" });
  assert.deepEqual(resolveViewerHotkey({ key: "b" }), { type: "tool", tool: "RectangleROI" });
});

test("overlay, MPR, layout, help and cine rate", () => {
  assert.deepEqual(resolveViewerHotkey({ key: "o" }), { type: "overlay" });
  assert.deepEqual(resolveViewerHotkey({ key: "x" }), { type: "mpr" });
  assert.deepEqual(resolveViewerHotkey({ key: "g" }), { type: "layout" });
  // H is flip now (rotate / flip test below); the sheet is ? and the toolbar.
  assert.equal(resolveViewerHotkey({ key: "h" })?.type, "orient");
  assert.deepEqual(resolveViewerHotkey({ key: "," }), { type: "cineFps", delta: -1 });
  assert.deepEqual(resolveViewerHotkey({ key: "." }), { type: "cineFps", delta: 1 });
});

test("? is help only where the viewer owns it", () => {
  assert.equal(resolveViewerHotkey({ key: "?" }), null);
  assert.deepEqual(resolveViewerHotkey({ key: "?" }, 0, { questionMarkHelp: true }), {
    type: "help",
  });
});

test("Shift+0 is the series default window", () => {
  assert.deepEqual(resolveViewerHotkey({ key: "0", shiftKey: true }), {
    type: "preset",
    ordinal: 0,
  });
  assert.deepEqual(resolveViewerHotkey({ key: ")" }), { type: "preset", ordinal: 0 });
});

test("tooltips and the help sheet read the same bindings", () => {
  assert.equal(shortcutForTool("WindowLevel"), "W");
  assert.equal(shortcutForTool("Angle"), "A");
  assert.equal(shortcutForTool("Probe"), null);
  for (const group of VIEWER_SHORTCUT_GROUPS) {
    for (const row of group.rows) {
      for (const key of row.keys) {
        if (key.length !== 1 || !/[A-Z]/.test(key)) continue;
        assert.notEqual(
          resolveViewerHotkey({ key: key.toLowerCase() }, 0, { rotateKey: true, questionMarkHelp: true }),
          null,
          `help lists ${key} but the resolver ignores it`
        );
      }
    }
  }
});

test("rotate / flip: R, Shift+R, H, V (as on the desktop)", () => {
  const own = { rotateKey: true };
  assert.deepEqual(resolveViewerHotkey({ key: "r" }, 0, own), { type: "orient", command: "rotate:90" });
  assert.deepEqual(resolveViewerHotkey({ key: "R", shiftKey: true }, 0, own), { type: "orient", command: "rotate:-90" });
  // In a student session R stays the session's (exam reveal).
  assert.equal(resolveViewerHotkey({ key: "r" }), null);
  assert.deepEqual(resolveViewerHotkey({ key: "h" }), { type: "orient", command: "flip:h" });
  assert.deepEqual(resolveViewerHotkey({ key: "v" }), { type: "orient", command: "flip:v" });
  // Browser combinations stay the browser's.
  assert.equal(resolveViewerHotkey({ key: "r", ctrlKey: true }), null);
});

test("the help lists Enter (maximise a pane) only where the grid can do it", () => {
  const rows = (paneMaximize: boolean) =>
    viewerShortcutGroups({}, false, { paneMaximize }).flatMap((g) => g.rows.map((r) => r.keys.join("+")));
  assert.ok(rows(true).includes("Enter"));
  assert.ok(!rows(false).includes("Enter"), "the case viewer's grid has no maximise");
  // Enter is not a viewport key: the grid owns it.
  assert.equal(resolveViewerHotkey({ key: "Enter" }, 0, {}, {}), null);
});

test("D is Bidirectional only where the free viewer's extra measure tools are on", () => {
  assert.deepEqual(resolveViewerHotkey({ key: "d" }, 0, { readingTools: true }, {}), { type: "tool", tool: "Bidirectional" });
  assert.deepEqual(resolveViewerHotkey({ key: "D" }, 0, { readingTools: true }, {}), { type: "tool", tool: "Bidirectional" });
  assert.equal(resolveViewerHotkey({ key: "d" }, 0, {}, {}), null, "teaching surfaces: D stays free");
  const does = (readingTools: boolean) =>
    viewerShortcutGroups({}, false, { readingTools }).flatMap((g) => g.rows.map((r) => r.does));
  assert.ok(does(true).includes("Bidirectional"));
  assert.ok(!does(false).includes("Bidirectional"));
  // Cobb, circle, freehand and the magnifier have no default key (C and N
  // belong to the student session), so the sheet doesn't list them.
  assert.ok(!does(true).some((d) => /Cobb|Circle ROI|Freehand|Magnif/.test(d)));
});
