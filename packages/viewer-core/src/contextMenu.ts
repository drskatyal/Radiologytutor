/**
 * The viewer's right-click menus as data, shared by the desktop and the web.
 *
 * Three menus: on the image, on an annotation (the annotation items first,
 * then the image menu), and on a series thumbnail. Each item carries a stable
 * command id ("preset:ct-lung", "layout:2x2", "monitor:\\.\DISPLAY2"…) that
 * the app maps to its own action, and the keyboard shortcut the app reports
 * for that command. Submenus are thunks: nothing inside one is built until it
 * opens. Items the app cannot do (no MPR on the web, one monitor…) are left
 * out rather than shown disabled, so the menu stays short.
 */

export type MenuCommand = string;

export type MenuEntry =
  | {
      kind: "item";
      id: MenuCommand;
      label: string;
      shortcut?: string;
      checked?: boolean;
      disabled?: boolean;
      /** Colour chip (monitor / annotation colour). */
      swatch?: string;
      hint?: string;
    }
  | { kind: "sub"; id: string; label: string; hint?: string; items: () => MenuEntry[] }
  | { kind: "sep" }
  | { kind: "label"; label: string };

export interface MenuPreset {
  id: string;
  label: string;
  ww: number;
  wc: number;
}

export interface MenuMonitor {
  name: string;
  /** 1-based, as in the monitor picker. */
  number: number;
  color: string;
  /** The monitor this window is on. */
  current?: boolean;
}

export interface ImageMenuContext {
  modality?: string;
  /** Tools the app offers here, in menu order. */
  tools: { id: string; label: string }[];
  activeTool?: string;
  /** Window presets for this modality (the app's list). */
  presets: MenuPreset[];
  inverted?: boolean;
  monitors?: MenuMonitor[];
  links: { scroll: boolean; voi: boolean; zoom: boolean };
  referenceLines: boolean;
  overlay: boolean;
  annotations: boolean;
  cine?: { playing: boolean; fps: number } | null;
  /** Slab state; null when slabs are not available for this image. */
  slab?: { mode: "off" | "mip" | "minip" | "avg"; mm: number } | null;
  layout?: { rows: number; cols: number } | null;
  /** Capabilities; `links` and `cineFps` default to on (a single-pane viewer turns links off). */
  can: Partial<Record<"reformat" | "mpr" | "threeD" | "video" | "tags" | "comparePrior" | "copyImage" | "saveImage" | "customLayout" | "links" | "cineFps", boolean>>;
  /** The key shown next to a command, if it has one. */
  shortcut: (id: MenuCommand) => string | undefined;
}

const item = (ctx: { shortcut: (id: MenuCommand) => string | undefined }, id: MenuCommand, label: string, extra: Partial<Extract<MenuEntry, { kind: "item" }>> = {}): MenuEntry => ({
  kind: "item",
  id,
  label,
  shortcut: ctx.shortcut(id),
  ...extra,
});
const sep: MenuEntry = { kind: "sep" };

/** Drop leading/trailing/double separators left by omitted sections. */
export function tidy(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (e.kind === "sep" && (out.length === 0 || out[out.length - 1].kind === "sep")) continue;
    out.push(e);
  }
  while (out.length && out[out.length - 1].kind === "sep") out.pop();
  return out;
}

export const SLAB_THICKNESS_MM = [2, 5, 10, 15, 20, 30] as const;
export const CINE_FPS = [5, 10, 15, 20, 30, 60] as const;

/** Right-click on the image. */
export function imageMenu(ctx: ImageMenuContext): MenuEntry[] {
  const mr = (ctx.modality ?? "").toUpperCase() === "MR";
  const monitors = ctx.monitors ?? [];
  const entries: MenuEntry[] = [
    {
      kind: "sub",
      id: "tools",
      label: "Tools",
      hint: ctx.tools.find((t) => t.id === ctx.activeTool)?.label,
      items: () => ctx.tools.map((t) => item(ctx, `tool:${t.id}`, t.label, { checked: t.id === ctx.activeTool })),
    },
    {
      kind: "sub",
      id: "window",
      label: "Window / level",
      items: () =>
        tidy([
          ...(mr || !ctx.presets.length ? [item(ctx, "preset:auto", mr ? "MR auto (from the image)" : "Auto (from the image)")] : []),
          ...ctx.presets.map((p) => item(ctx, `preset:${p.id}`, p.label, { hint: `${p.ww} / ${p.wc}` })),
          ...(!mr && ctx.presets.length ? [item(ctx, "preset:auto", "Series default")] : []),
          sep,
          item(ctx, "invert", "Invert", { checked: !!ctx.inverted }),
        ]),
    },
    {
      kind: "sub",
      id: "zoom",
      label: "Zoom, rotate, flip",
      items: () => [
        item(ctx, "zoom:fit", "Fit to viewport"),
        item(ctx, "zoom:1", "Actual size (1:1)"),
        item(ctx, "zoom:2", "Zoom 2×"),
        sep,
        item(ctx, "rotate:90", "Rotate 90° right"),
        item(ctx, "rotate:-90", "Rotate 90° left"),
        item(ctx, "flip:h", "Flip horizontal"),
        item(ctx, "flip:v", "Flip vertical"),
      ],
    },
    item(ctx, "reset", "Reset view"),
    sep,
  ];
  if (ctx.slab) {
    const slab = ctx.slab;
    entries.push({
      kind: "sub",
      id: "slab",
      label: "Slab",
      hint: slab.mode === "off" ? undefined : `${slabName(slab.mode)} ${slab.mm} mm`,
      items: () => [
        item(ctx, "slab:off", "Thin (single slice)", { checked: slab.mode === "off" }),
        item(ctx, "slab:mip", "MIP", { checked: slab.mode === "mip" }),
        item(ctx, "slab:minip", "MinIP", { checked: slab.mode === "minip" }),
        item(ctx, "slab:avg", "Average (AvgIP)", { checked: slab.mode === "avg" }),
        { kind: "label", label: "Thickness" },
        ...SLAB_THICKNESS_MM.map((mm) => item(ctx, `slab-mm:${mm}`, `${mm} mm`, { checked: slab.mode !== "off" && slab.mm === mm })),
      ],
    });
  }
  if (ctx.can.reformat || ctx.can.mpr || ctx.can.threeD) {
    entries.push({
      kind: "sub",
      id: "reformat",
      label: "Reformat",
      items: () =>
        tidy([
          ...(ctx.can.reformat
            ? [item(ctx, "reformat:axial", "Axial"), item(ctx, "reformat:coronal", "Coronal"), item(ctx, "reformat:sagittal", "Sagittal")]
            : []),
          sep,
          ...(ctx.can.mpr ? [item(ctx, "mpr", "Open MPR")] : []),
          ...(ctx.can.threeD ? [item(ctx, "3d", "3D volume")] : []),
        ]),
    });
  }
  if (ctx.layout) {
    const l = ctx.layout;
    entries.push({
      kind: "sub",
      id: "layout",
      label: "Layout",
      hint: `${l.rows}×${l.cols}`,
      items: () =>
        tidy([
          ...[
            [1, 1],
            [1, 2],
            [2, 2],
          ].map(([r, c]) => item(ctx, `layout:${r}x${c}`, `${r} × ${c}`, { checked: l.rows === r && l.cols === c })),
          ...(ctx.can.customLayout
            ? [
                { kind: "label" as const, label: "More" },
                ...[
                  [2, 1],
                  [1, 3],
                  [2, 3],
                  [3, 3],
                ].map(([r, c]) => item(ctx, `layout:${r}x${c}`, `${r} × ${c}`, { checked: l.rows === r && l.cols === c })),
              ]
            : []),
        ]),
    });
  }
  const others = monitors.filter((m) => !m.current);
  if (others.length) {
    entries.push({
      kind: "sub",
      id: "monitor",
      label: "Send to monitor",
      items: () => monitors.map((m) => item(ctx, `monitor:${m.name}`, `Monitor ${m.number}`, { swatch: m.color, disabled: m.current, hint: m.current ? "this one" : undefined })),
    });
  }
  if (ctx.can.links !== false) entries.push(
    {
      kind: "sub",
      id: "links",
      label: "Link",
      hint: [ctx.links.scroll && "scroll", ctx.links.voi && "W/L", ctx.links.zoom && "zoom"].filter(Boolean).join(" · ") || undefined,
      items: () => [
        item(ctx, "link:scroll", "Scroll (position)", { checked: ctx.links.scroll }),
        item(ctx, "link:voi", "Window / level", { checked: ctx.links.voi }),
        item(ctx, "link:zoom", "Zoom and pan", { checked: ctx.links.zoom }),
      ],
    },
    item(ctx, "refLines", "Reference lines", { checked: ctx.referenceLines }),
    sep
  );
  if (ctx.cine && ctx.can.cineFps === false) {
    entries.push(item(ctx, "cine", ctx.cine.playing ? "Stop cine" : "Play cine"));
  } else if (ctx.cine) {
    const cine = ctx.cine;
    entries.push({
      kind: "sub",
      id: "cine",
      label: "Cine",
      hint: cine.playing ? `${cine.fps} fps` : undefined,
      items: () => [
        item(ctx, "cine", cine.playing ? "Stop" : "Play"),
        { kind: "label", label: "Frames per second" },
        ...CINE_FPS.map((fps) => item(ctx, `fps:${fps}`, `${fps} fps`, { checked: cine.fps === fps })),
      ],
    });
  }
  entries.push(
    item(ctx, "overlay", "Image text (overlay)", { checked: ctx.overlay }),
    item(ctx, "annotations", "Annotations", { checked: ctx.annotations }),
    sep
  );
  if (ctx.can.copyImage || ctx.can.saveImage || ctx.can.video) {
    entries.push({
      kind: "sub",
      id: "export",
      label: "Export",
      items: () =>
        tidy([
          ...(ctx.can.copyImage ? [item(ctx, "copyImage", "Copy image")] : []),
          ...(ctx.can.saveImage ? [item(ctx, "save:png", "Save as PNG…", { hint: "anonymised" }), item(ctx, "save:jpeg", "Save as JPEG…", { hint: "anonymised" })] : []),
          ...(ctx.can.video ? [sep, item(ctx, "video", "Series as video…")] : []),
        ]),
    });
  }
  if (ctx.can.tags) entries.push(item(ctx, "tags", "DICOM tags…"));
  if (ctx.can.comparePrior) entries.push(item(ctx, "comparePrior", "Compare with prior…"));
  return tidy(entries);
}

function slabName(mode: "off" | "mip" | "minip" | "avg"): string {
  return mode === "mip" ? "MIP" : mode === "minip" ? "MinIP" : mode === "avg" ? "AvgIP" : "Thin";
}

/** Annotation colours on offer (high contrast on grey images; never the accent). */
export const ANNOTATION_COLORS: readonly { id: string; label: string; color: string }[] = [
  { id: "yellow", label: "Yellow", color: "#FACC15" },
  { id: "green", label: "Green", color: "#22C55E" },
  { id: "cyan", label: "Cyan", color: "#22D3EE" },
  { id: "red", label: "Red", color: "#EF4444" },
  { id: "magenta", label: "Magenta", color: "#E879F9" },
  { id: "white", label: "White", color: "#FFFFFF" },
];

export interface AnnotationMenuContext {
  /** An arrow / text annotation: its label can be edited. */
  labelled: boolean;
  hasLabel: boolean;
  /** "Length 23.4 mm" etc., for Copy value. */
  value?: string;
  color?: string;
  onImage: number;
  inSeries: number;
  shortcut: (id: MenuCommand) => string | undefined;
}

/** Right-click on an annotation: these come before the image menu. */
export function annotationMenu(ctx: AnnotationMenuContext): MenuEntry[] {
  return tidy([
    ...(ctx.labelled ? [item(ctx, "ann:label", ctx.hasLabel ? "Edit label" : "Add label")] : []),
    {
      kind: "sub",
      id: "ann-color",
      label: "Colour",
      items: () => ANNOTATION_COLORS.map((c) => item(ctx, `ann:color:${c.color}`, c.label, { swatch: c.color, checked: ctx.color?.toUpperCase() === c.color })),
    },
    ...(ctx.value ? [item(ctx, "ann:copy", "Copy value", { hint: ctx.value.length > 26 ? `${ctx.value.slice(0, 25)}…` : ctx.value })] : []),
    item(ctx, "ann:delete", "Delete"),
    sep,
    item(ctx, "ann:deleteImage", "Delete all on this image", { hint: String(ctx.onImage), disabled: !ctx.onImage }),
    item(ctx, "ann:deleteSeries", "Delete all in series", { hint: String(ctx.inSeries), disabled: !ctx.inSeries }),
  ]);
}

export interface ThumbnailMenuContext {
  monitors?: MenuMonitor[];
  can: Partial<Record<"newLayout" | "reformat" | "info" | "hide", boolean>>;
  shortcut: (id: MenuCommand) => string | undefined;
}

/** Right-click on a series thumbnail. */
export function thumbnailMenu(ctx: ThumbnailMenuContext): MenuEntry[] {
  const others = (ctx.monitors ?? []).filter((m) => !m.current);
  return tidy([
    item(ctx, "thumb:open", "Open in active pane"),
    ...others.map((m) => item(ctx, `thumb:monitor:${m.name}`, `Open on monitor ${m.number}`, { swatch: m.color })),
    ...(ctx.can.newLayout ? [item(ctx, "thumb:newLayout", "Open in a new layout pane")] : []),
    ...(ctx.can.reformat ? [sep, item(ctx, "thumb:reformat:coronal", "Quick coronal"), item(ctx, "thumb:reformat:sagittal", "Quick sagittal")] : []),
    sep,
    ...(ctx.can.info ? [item(ctx, "thumb:info", "Series info…")] : []),
    ...(ctx.can.hide ? [item(ctx, "thumb:hide", "Hide series")] : []),
  ]);
}

/** Every command id in a menu (submenus expanded): for tests and shortcut tables. */
export function commandsOf(entries: readonly MenuEntry[]): MenuCommand[] {
  return entries.flatMap((e) => (e.kind === "item" ? [e.id] : e.kind === "sub" ? commandsOf(e.items()) : []));
}
