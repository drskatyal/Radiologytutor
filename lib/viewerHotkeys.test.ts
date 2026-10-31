import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  TOOL_DIGITS,
  VIEWER_SHORTCUT_GROUPS,
  shortcutForTool,
  VIEWER_HOTKEY_HINTS,
  isTextTarget,
  resolveViewerHotkey,
} from "./viewerHotkeys";

// Keys the student session already binds on `window`
// (components/student/StudentSession.tsx + lib/seriesRailPreference.ts).
const SESSION_KEYS = ["c", "n", "p", "r", "t", "f", "[", "?", " "];

test("digits pick the left-button tool", () => {
  assert.deepEqual(resolveViewerHotkey({ key: "1" }), { type: "tool", tool: "StackScroll" });
  assert.deepEqual(resolveViewerHotkey({ key: "2" }), { type: "tool", tool: "WindowLevel" });
  assert.deepEqual(resolveViewerHotkey({ key: "3" }), { type: "tool", tool: "Zoom" });
  assert.deepEqual(resolveViewerHotkey({ key: "4" }), { type: "tool", tool: "Pan" });
  assert.deepEqual(resolveViewerHotkey({ key: "5" }), { type: "tool", tool: "Length" });
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
  assert.deepEqual(resolveViewerHotkey({ key: "0" }), { type: "reset" });
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

test("a preset shortcut never doubles as a tool shortcut", () => {
  for (const digit of Object.keys(TOOL_DIGITS)) {
    const shifted = resolveViewerHotkey({ key: digit, shiftKey: true });
    assert.equal(shifted?.type, "preset", `Shift+${digit}`);
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
  assert.deepEqual(resolveViewerHotkey({ key: "h" }), { type: "help" });
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
  assert.equal(shortcutForTool("WindowLevel"), "2 · W");
  assert.equal(shortcutForTool("Angle"), "A");
  assert.equal(shortcutForTool("Probe"), null);
  for (const group of VIEWER_SHORTCUT_GROUPS) {
    for (const row of group.rows) {
      for (const key of row.keys) {
        if (key.length !== 1 || !/[A-Z]/.test(key)) continue;
        assert.notEqual(
          resolveViewerHotkey({ key: key.toLowerCase() }),
          null,
          `help lists ${key} but the resolver ignores it`
        );
      }
    }
  }
});
