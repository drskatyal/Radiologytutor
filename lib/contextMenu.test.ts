import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotationMenu,
  commandsOf,
  imageMenu,
  thumbnailMenu,
  tidy,
  type ImageMenuContext,
  type MenuEntry,
} from "../packages/viewer-core/src/contextMenu.ts";

const keys: Record<string, string> = { "tool:Length": "M", "preset:ct-lung": "1", reset: "Esc", "layout:2x2": "Shift+4" };
const base = (over: Partial<ImageMenuContext> = {}): ImageMenuContext => ({
  modality: "CT",
  tools: [
    { id: "StackScroll", label: "Scroll" },
    { id: "Length", label: "Length" },
  ],
  activeTool: "Length",
  presets: [
    { id: "ct-lung", label: "Lung", ww: 1500, wc: -600 },
    { id: "ct-brain", label: "Brain", ww: 80, wc: 40 },
  ],
  links: { scroll: true, voi: false, zoom: false },
  referenceLines: false,
  overlay: true,
  annotations: true,
  cine: { playing: false, fps: 15 },
  slab: { mode: "off", mm: 10 },
  layout: { rows: 1, cols: 2 },
  monitors: [
    { name: "A", number: 1, color: "#16A34A", current: true },
    { name: "B", number: 2, color: "#EA580C" },
  ],
  can: { reformat: true, mpr: true, threeD: true, video: true, tags: true, comparePrior: true, copyImage: true, saveImage: true, customLayout: true },
  shortcut: (id) => keys[id],
  ...over,
});
const find = (entries: readonly MenuEntry[], id: string): MenuEntry | undefined => {
  for (const e of entries) {
    if ((e.kind === "item" || e.kind === "sub") && e.id === id) return e;
    if (e.kind === "sub") {
      const inner = find(e.items(), id);
      if (inner) return inner;
    }
  }
  return undefined;
};

test("image menu: every section of the spec is there on a CT with two monitors", () => {
  const ids = commandsOf(imageMenu(base()));
  for (const id of [
    "tool:Length", "preset:ct-lung", "invert", "zoom:fit", "zoom:1", "zoom:2", "rotate:90", "flip:h", "reset",
    "slab:mip", "slab:minip", "slab:avg", "slab-mm:10", "reformat:coronal", "mpr", "3d", "layout:2x2", "layout:2x3", "layout:3x3",
    "monitor:B", "link:scroll", "link:voi", "link:zoom", "refLines", "cine", "fps:30", "overlay", "annotations",
    "copyImage", "save:png", "save:jpeg", "video", "tags", "comparePrior",
  ]) assert.ok(ids.includes(id), id);
});

test("image menu: shortcuts and states shown; submenus are lazy", () => {
  let built = 0;
  const ctx = base();
  const menu = imageMenu({ ...ctx, presets: new Proxy(ctx.presets, { get: (t, k) => ((k === "map" && (built += 1)), Reflect.get(t, k)) }) });
  assert.equal(built, 0, "presets are not built until the W/L submenu opens");
  const lung = find(menu, "preset:ct-lung");
  assert.equal(lung?.kind === "item" && lung.shortcut, "1");
  const len = find(menu, "tool:Length");
  assert.ok(len?.kind === "item" && len.checked && len.shortcut === "M");
  const scroll = find(menu, "link:scroll");
  assert.ok(scroll?.kind === "item" && scroll.checked);
  const b = find(menu, "monitor:B");
  assert.ok(b?.kind === "item" && b.swatch === "#EA580C", "monitor colour matches the picker");
});

test("image menu: what the app cannot do is left out (web: no slab, MPR, monitors, layout)", () => {
  const ids = commandsOf(imageMenu(base({ slab: null, layout: null, monitors: [], cine: null, can: { copyImage: true, saveImage: true, tags: true, links: false } })));
  for (const id of ["slab:mip", "mpr", "3d", "monitor:B", "layout:2x2", "cine", "video", "comparePrior", "link:scroll", "refLines"]) assert.ok(!ids.includes(id), id);
  const plainCine = imageMenu(base({ can: { cineFps: false } }));
  assert.ok(plainCine.some((e) => e.kind === "item" && e.id === "cine" && e.label === "Play cine"), "cine without an fps list");
  assert.ok(ids.includes("save:png") && ids.includes("tags"));
});

test("MR: auto window first, no CT presets offered", () => {
  const win = find(imageMenu(base({ modality: "MR", presets: [] })), "window");
  assert.ok(win?.kind === "sub");
  const items = win.items();
  assert.equal(items[0].kind === "item" && items[0].id, "preset:auto");
  assert.ok(!commandsOf(items).some((id) => id.startsWith("preset:ct-")));
});

test("annotation menu: edit label, colour, copy value, delete, delete all", () => {
  const ids = commandsOf(annotationMenu({ labelled: true, hasLabel: false, value: "Length 23.4 mm", onImage: 2, inSeries: 5, shortcut: () => undefined }));
  for (const id of ["ann:label", "ann:color:#FACC15", "ann:copy", "ann:delete", "ann:deleteImage", "ann:deleteSeries"]) assert.ok(ids.includes(id), id);
  assert.ok(!commandsOf(annotationMenu({ labelled: false, hasLabel: false, onImage: 0, inSeries: 0, shortcut: () => undefined })).includes("ann:label"));
});

test("thumbnail menu: open here, on another monitor, new pane, quick reformats, info, hide", () => {
  const ids = commandsOf(thumbnailMenu({ monitors: base().monitors, can: { newLayout: true, reformat: true, info: true, hide: true }, shortcut: () => undefined }));
  assert.deepEqual(ids, ["thumb:open", "thumb:monitor:B", "thumb:newLayout", "thumb:reformat:coronal", "thumb:reformat:sagittal", "thumb:info", "thumb:hide"]);
});

test("tidy: no leading, trailing or doubled separators", () => {
  const s: MenuEntry = { kind: "sep" };
  const a: MenuEntry = { kind: "item", id: "a", label: "A" };
  assert.deepEqual(tidy([s, a, s, s, a, s]), [a, s, a]);
});
