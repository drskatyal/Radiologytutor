// Tool-matched mouse cursors for the image viewports.
//
// Cornerstone's own SVG cursors are turned off (`useCursors: false` in
// engine.ts): they drew the same green crosshair for every tool. Instead the
// body carries `data-tool-cursor` for the active left-button tool and one
// injected stylesheet maps it onto every stack viewport:
//
//   browse (B)      vertical double arrow
//   window (W)      contrast disc (half white, half black)
//   zoom (Z)        magnifier
//   pan (P)         open hand; closed hand while dragging
//   measure tools   precise crosshair
//   eraser          eraser
//
// Custom cursors are small SVGs (crisp at any DPI) with the hotspot on the
// point that acts: the lens centre, the disc centre, the arrow's middle. A
// HiDPI image-set comes first; engines without cursor image-set fall back to
// the 1x SVG, then to the closest built-in cursor. Over the viewport's own UI
// (buttons, menus, inline editors) the normal arrow / text cursor applies.

export type CursorKind = "scroll" | "wl" | "zoom" | "pan" | "crosshair" | "eraser" | "default";

const MEASURE = new Set([
  "Length",
  "Angle",
  "CobbAngle",
  "EllipticalROI",
  "RectangleROI",
  "CircleROI",
  "PlanarFreehandROI",
  "Probe",
  "ArrowAnnotate",
  "Bidirectional",
  "Magnify",
  "Crosshairs",
]);

export function cursorForTool(tool: string): CursorKind {
  if (tool === "StackScroll") return "scroll";
  if (tool === "WindowLevel") return "wl";
  if (tool === "Zoom") return "zoom";
  if (tool === "Pan") return "pan";
  if (tool === "Eraser") return "eraser";
  if (MEASURE.has(tool)) return "crosshair";
  return "default";
}

// 24×24 artwork: a dark outline under a white stroke reads on black images
// and on white UI alike.
const OUTLINE = 'stroke="#000" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"';
const INK = 'stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"';
const ART: Record<"scroll" | "wl" | "zoom" | "eraser", { body: string; hotspot: [number, number]; fallback: string }> = {
  scroll: {
    body: `<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4" ${OUTLINE}/><path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4" ${INK}/>`,
    hotspot: [12, 12],
    fallback: "ns-resize",
  },
  wl: {
    body:
      `<circle cx="12" cy="12" r="8" fill="#000" stroke="#000" stroke-width="3.2"/>` +
      `<path d="M12 4a8 8 0 0 0 0 16z" fill="#fff"/>` +
      `<circle cx="12" cy="12" r="8" fill="none" stroke="#fff" stroke-width="1.6"/>`,
    hotspot: [12, 12],
    fallback: "crosshair",
  },
  zoom: {
    body:
      `<circle cx="10" cy="10" r="6" ${OUTLINE}/><path d="M14.5 14.5L21 21" ${OUTLINE} stroke-width="4.4"/>` +
      `<circle cx="10" cy="10" r="6" ${INK}/><path d="M14.5 14.5L21 21" ${INK} stroke-width="2.6"/>` +
      `<path d="M7.5 10h5M10 7.5v5" ${INK} stroke-width="1.4"/>`,
    hotspot: [10, 10],
    fallback: "zoom-in",
  },
  eraser: {
    body:
      `<path d="M4 16l8.5-8.5a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L13 19H7z" ${OUTLINE}/>` +
      `<path d="M4 16l8.5-8.5a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L13 19H7z" fill="#fff" stroke="#fff" stroke-width="1"/>` +
      `<path d="M8.5 11.5l5 5" stroke="#000" stroke-width="1.4"/>`,
    hotspot: [5, 17],
    fallback: "crosshair",
  },
};

function svgUrl(body: string, px: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** The CSS `cursor` values for a kind: HiDPI first, then 1x, then built-in. */
export function cursorCss(kind: CursorKind): string[] {
  if (kind === "pan") return ["grab"];
  if (kind === "crosshair") return ["crosshair"];
  if (kind === "default") return ["default"];
  const { body, hotspot, fallback } = ART[kind];
  const [x, y] = hotspot;
  const one = svgUrl(body, 24);
  const two = svgUrl(body, 48);
  return [`${one} ${x} ${y}, ${fallback}`, `-webkit-image-set(${one} 1x, ${two} 2x) ${x} ${y}, ${fallback}`, `image-set(${one} 1x, ${two} 2x) ${x} ${y}, ${fallback}`];
}

const KINDS: CursorKind[] = ["scroll", "wl", "zoom", "pan", "crosshair", "eraser", "default"];
/** The image surfaces a tool cursor applies to (not the viewport's own UI). */
const SURFACE = (scope: string) => `${scope} .cs-viewport, ${scope} .cs-viewport canvas, ${scope} .cs-viewport svg`;

function stylesheet(): string {
  const rules: string[] = [];
  for (const kind of KINDS) {
    // Later declarations win where supported; unsupported ones are dropped.
    const values = cursorCss(kind).map((v) => `cursor: ${v} !important;`).join(" ");
    rules.push(`${SURFACE(`body[data-tool-cursor="${kind}"]`)} { ${values} }`);
    rules.push(`.tool-cursor-${kind} { ${values.replace(/ !important/g, "")} }`);
  }
  // Pan: closed hand while the button is down.
  rules.push(`${SURFACE('body[data-tool-cursor="pan"]').split(", ").map((s) => s.replace(".cs-viewport", ".cs-viewport:active")).join(", ")} { cursor: grabbing !important; }`);
  rules.push(`.tool-cursor-pan:active { cursor: grabbing; }`);
  return rules.join("\n");
}

let installed = false;
/** Inject the cursor stylesheet once (idempotent; tiny). */
export function installToolCursors(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.dataset.flowrad = "tool-cursors";
  style.textContent = stylesheet();
  document.head.appendChild(style);
}

/** Show the cursor for the active left-button tool on every stack viewport. */
export function setToolCursor(tool: string): void {
  installToolCursors();
  document.body.dataset.toolCursor = cursorForTool(tool);
}
