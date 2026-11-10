"use client";

// The viewer's one toolbar. A single quiet row on near-black, light icons,
// one accent for the selected tool — the reading-room bar OHIF and Stradus
// converge on, minus the captions and group headings that made ours wallpaper
// (docs/UI_AUDIT.md, "Viewer chrome").
//
//   [Stack|MPR] │ Scroll W/L Pan Zoom │ Length▾ │ Preset▾ Invert │ Cine fps ┊ Reset Clear │ Overlay ?
//
// Every control has a tooltip that names its shortcut (read from
// lib/viewerHotkeys.ts, so the two cannot drift), presses give instant
// feedback (75 ms scale + fill, no 500 ms ease), and the menus are real Radix
// menus — arrow keys, typeahead, Escape — closing the half of backlog #3 the
// last pass left open.
//
// No Cornerstone import: this file only renders state the viewer owns.

import { Fragment, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Blend,
  Combine,
  Captions,
  CaptionsOff,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDot,
  Crosshair,
  DraftingCompass,
  Eraser,
  ImageDown,
  Download,
  Keyboard,
  Lasso,
  MessageSquareText,
  Mic,
  MicOff,
  Layers,
  LocateFixed,
  Maximize2,
  Minimize2,
  Move,
  MoveDiagonal2,
  MoveUpRight,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Route,
  Ruler,
  ListOrdered,
  ScanSearch,
  SlidersHorizontal,
  Square,
  SunMoon,
  Triangle,
  Type,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import { Menu, MenuItem, MenuLabel, MenuSeparator, Tooltip } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { CINE_FPS_OPTIONS } from "@/lib/cinePlayer";
import type { OverlayDensity } from "@/lib/dicomOverlay";
import { shortcutForPreset, shortcutForToolIn } from "@/lib/viewerHotkeys";
import { isMac } from "@flowrad/viewer-core/bindings";
import type { MprMode, MprPlane, MprRender } from "@/lib/mpr";
import { FULL_DYNAMIC_ID, type WindowPreset } from "@/lib/windowPresets";
import { ImagingStageContext } from "./stageContext";
import { ORIENTATION_COMMANDS, type OrientationCommand } from "@flowrad/viewer-core";

export type ViewerTool = {
  name: string;
  label: string;
  annotation?: boolean;
};

// Scroll leads so the reading-room default stays on screen when a narrow
// series rail leaves only ~150px for the bar. Window/Level is the next tap.
export const NAV_TOOLS: ViewerTool[] = [
  { name: "StackScroll", label: "Scroll" },
  { name: "WindowLevel", label: "Window / level" },
  { name: "Pan", label: "Pan" },
  { name: "Zoom", label: "Zoom" },
];

// Length on the face; the rest in the split menu (OHIF's MeasurementTools).
export const MEASURE_TOOLS: ViewerTool[] = [
  { name: "Length", label: "Length", annotation: true },
  { name: "Angle", label: "Angle", annotation: true },
  { name: "EllipticalROI", label: "Ellipse ROI", annotation: true },
  { name: "RectangleROI", label: "Rectangle ROI", annotation: true },
  { name: "Probe", label: "Probe (HU)", annotation: true },
  { name: "ArrowAnnotate", label: "Arrow", annotation: true },
  // Not a Cornerstone tool: clicks go to AnnotationEditLayer, which deletes.
  { name: "Eraser", label: "Eraser (click to delete)" },
];

/**
 * The free viewer's full measure set, as on the desktop: adds Cobb angle,
 * bidirectional (long / short axis), circle and freehand ROIs and the
 * magnifying glass. Teaching surfaces keep `MEASURE_TOOLS`: their recordings
 * and replays are built around those tools.
 */
export const READING_MEASURE_TOOLS: ViewerTool[] = [
  { name: "Length", label: "Length", annotation: true },
  { name: "Angle", label: "Angle", annotation: true },
  { name: "CobbAngle", label: "Cobb angle", annotation: true },
  { name: "Bidirectional", label: "Bidirectional", annotation: true },
  { name: "EllipticalROI", label: "Ellipse ROI", annotation: true },
  { name: "RectangleROI", label: "Rectangle ROI", annotation: true },
  { name: "CircleROI", label: "Circle ROI", annotation: true },
  { name: "PlanarFreehandROI", label: "Freehand ROI", annotation: true },
  { name: "Probe", label: "Probe (HU)", annotation: true },
  { name: "ArrowAnnotate", label: "Arrow", annotation: true },
  // Reads no measurement: a loupe while the button is held.
  { name: "Magnify", label: "Magnifying glass" },
  { name: "Eraser", label: "Eraser (click to delete)" },
];

export const PRIMARY_TOOLS: ViewerTool[] = [...NAV_TOOLS, ...MEASURE_TOOLS];
/** Every tool any surface offers (labels, the annotation-tool set). */
export const ALL_TOOLS: ViewerTool[] = [...NAV_TOOLS, ...READING_MEASURE_TOOLS];

export function toolLabel(name: string): string {
  return ALL_TOOLS.find((t) => t.name === name)?.label ?? name;
}

/** MPR only: the left button drags the shared centre of all three planes. */
export const CROSSHAIRS_TOOL: ViewerTool = { name: "Crosshairs", label: "Crosshairs (links the planes)" };

const TOOL_ICONS: Record<string, LucideIcon> = {
  Crosshairs: LocateFixed,
  WindowLevel: Blend,
  Pan: Move,
  Zoom: ZoomIn,
  StackScroll: Layers,
  Length: Ruler,
  Angle: Triangle,
  EllipticalROI: Circle,
  RectangleROI: Square,
  Probe: Crosshair,
  ArrowAnnotate: MoveUpRight,
  CobbAngle: DraftingCompass,
  Bidirectional: MoveDiagonal2,
  CircleROI: CircleDot,
  PlanarFreehandROI: Lasso,
  Magnify: ScanSearch,
  Eraser,
};

function keysOf(shortcut: string | null): string[] | null {
  return shortcut ? shortcut.split(" · ") : null;
}

/** Fullscreen element (or body) — where menus and tooltips must portal. */
function usePortalHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const sync = () => {
      const fs = document.fullscreenElement;
      setHost(fs instanceof HTMLElement ? fs : null);
    };
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  return host;
}

const pressable =
  "transition-[transform,background-color,color] duration-75 ease-out active:scale-[0.92] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-0 " +
  "disabled:pointer-events-none disabled:opacity-35";

const idle = "text-white/75 hover:bg-white/10 hover:text-white active:bg-white/20";
// Neutral on the image: the tutor's ink is the only colour over the CT.
const selected = "bg-white text-black shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]";
const square =
  "h-9 w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 group-data-[dense=true]/tb:w-8";

export function ToolbarButton({
  label,
  shortcut,
  active = false,
  pressed,
  disabled = false,
  onClick,
  container,
  className,
  children,
  onWarm,
}: {
  /** Pointer over / focus: start loading what a click will need. */
  onWarm?: () => void;
  label: string;
  shortcut?: string[] | null;
  /** Selected state (tool, toggle on). */
  active?: boolean;
  /** `aria-pressed`; defaults to `active`. Pass `undefined`-free false for plain actions. */
  pressed?: boolean | null;
  disabled?: boolean;
  onClick: () => void;
  container?: HTMLElement | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label} shortcut={shortcut} container={container}>
      <button
        type="button"
        aria-label={shortcut?.length ? `${label} (${shortcut.join(" or ")})` : label}
        aria-pressed={pressed === null ? undefined : (pressed ?? active)}
        disabled={disabled}
        onClick={onClick}
        onPointerEnter={onWarm}
        onFocus={onWarm}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-md",
          square,
          pressable,
          active ? selected : idle,
          className
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-white/10 group-data-[dense=true]/tb:mx-0.5" />;
}

function Icon({ as: As }: { as: LucideIcon }) {
  return <As className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />;
}

export interface ViewerToolbarProps {
  /** `edge` — flush along the bottom of a pane. `dock` — a rounded bar under a square. */
  variant: "edge" | "dock";
  ready: boolean;
  activeTool: string;
  /** False when the study has no pixel spacing. */
  annotationsEnabled: boolean;
  /** False in MPR — measurements stay on the stack. */
  measurementsEnabled: boolean;
  /**
   * The slice on screen is an 8-bit CDN preview (lib/dicomCdn): there is no
   * real window to set until full-quality pixels arrive.
   */
  previewLocked?: boolean;
  inverted: boolean;
  activePreset: string | null;
  presets: WindowPreset[];
  viewMode: MprMode;
  /** Thin MPR, MIP slab or 3D, once in MPR. */
  mprRender: MprRender;
  onMprRender: (mode: MprRender) => void;
  /**
   * The plane this viewport shows: the series as acquired (stack), one plane
   * reformatted from the volume and enlarged, or all three. Absent: no switch.
   */
  plane?: "acquired" | "all" | MprPlane;
  onPlane?: (plane: "acquired" | "all" | MprPlane) => void;
  cineOffered: boolean;
  cinePlaying: boolean;
  cineFps: number;
  overlay: OverlayDensity;
  onSelectTool: (name: string) => void;
  onPreset: (preset: WindowPreset | null) => void;
  onInvert: () => void;
  onReset: () => void;
  /** Rotate / flip / reset orientation (the shared ORIENTATION_COMMANDS). */
  onOrientation: (command: OrientationCommand) => void;
  onClear: () => void;
  onViewMode: (mode: MprMode) => void;
  onCineToggle: () => void;
  onCineFps: (fps: number) => void;
  onOverlay: () => void;
  onHelp: () => void;
  /** Open the help sheet on the voice commands list. */
  onVoiceHelp?: () => void;
  /** Offline voice commands (mic toggle); absent where the browser has no microphone API. */
  voice?: { state: "off" | "loading" | "listening" | "error"; onToggle: () => void; onWarm?: () => void };
  /** Oblique, slab and curved MPR workspace (free viewer). */
  onRecon?: () => void;
  /** Free viewer, a study with a CT and a PET volume: open PET / CT fusion. */
  onFusion?: () => void;
  /** Text-box tool (free viewer; saved in this browser only). */
  textBox?: { active: boolean; onToggle: () => void };
  /** Save the image with its measurements and text boxes burned in. */
  onSaveAnnotated?: () => void;
  /** Free viewer: the Export dialog (images, video, anonymised DICOM). */
  onExport?: () => void;
  /** Free viewer: every measurement as a list and as report text. */
  onMeasurements?: () => void;
  /** Opens the Set window dialog (exact width / level). */
  onCustomWindow?: () => void;
  /** The measure menu (default: the teaching set, `MEASURE_TOOLS`). */
  measureTools?: ViewerTool[];
  /** The free viewer: tooltips and menu rows also show the desktop's tool letters (Y, N, C, P, Shift+E). */
  readingKeys?: boolean;
}

const PLANE_LABEL: Record<"acquired" | "all" | MprPlane, string> = {
  acquired: "Acquired",
  all: "All planes",
  axial: "Axial",
  coronal: "Coronal",
  sagittal: "Sagittal",
};

export function ViewerToolbar(props: ViewerToolbarProps) {
  const {
    variant,
    ready,
    activeTool,
    annotationsEnabled,
    measurementsEnabled,
    inverted,
    activePreset,
    presets,
    viewMode,
    mprRender,
    cineOffered,
    cinePlaying,
    cineFps,
    overlay,
    previewLocked = false,
    measureTools = MEASURE_TOOLS,
  } = props;
  const host = usePortalHost();
  const [measureOpen, setMeasureOpen] = useState(false);
  const stage = useContext(ImagingStageContext);
  const claimStage = stage?.claim;
  useEffect(() => claimStage?.(), [claimStage]);

  const activeMeasure = measureTools.find((t) => t.name === activeTool) ?? measureTools[0]!;
  const measureActive = measureTools.some((t) => t.name === activeTool);
  const measureBlocked = (tool: ViewerTool) =>
    !measurementsEnabled || (!!tool.annotation && !annotationsEnabled);
  const blockedReason = !measurementsEnabled
    ? "measurements stay on the stack view"
    : !annotationsEnabled
      ? "this study has no pixel spacing"
      : null;

  const presetName =
    activePreset === FULL_DYNAMIC_ID
      ? "Default"
      : presets.find((p) => p.id === activePreset)?.label ?? "Window";

  const overlayLabel =
    overlay === "full" ? "Overlay: full" : overlay === "basic" ? "Overlay: basic" : "Overlay: off";

  const { scrollerRef, rowRef, dense, edges, page } = useToolbarFit();

  return (
    <div
      className={cn(
        "relative w-full min-w-0 max-w-full bg-black text-white",
        variant === "edge"
          ? "border-t border-[#1F1F1F]"
          : "overflow-hidden rounded-lg border border-[#1F1F1F]"
      )}
    >
      <div
        ref={scrollerRef}
        data-dense={dense}
        className={cn(
          // The scroller is a block, not the flex row: a flex row that is also
          // the scroller reports its content width to the page and opens a
          // horizontal scrollbar on narrow stages.
          "group/tb w-full min-w-0 max-w-full touch-pan-x overflow-x-auto overscroll-x-contain",
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        )}
      >
      <div
        ref={rowRef}
        role="toolbar"
        aria-label="Viewer tools"
        aria-orientation="horizontal"
        className="flex w-max min-w-full items-center gap-0.5 px-1.5 py-1"
      >
        {/* View: one segmented control, four states. */}
        <div
          role="radiogroup"
          aria-label="View"
          className="inline-flex shrink-0 items-center rounded-md bg-[#181818] p-0.5"
        >
          {(
            [
              ["stack", "Stack", "Stack view", ["X"]],
              ["mpr", "MPR", "Three linked planes", ["X"]],
              ["mip", "MIP", "Maximum-intensity slab (15 mm)", null],
              ["3d", "3D", "Volume render — drag to rotate", null],
            ] as const
          ).map(([value, label, tip, baseKeys]) => {
            // The free viewer also has the desktop's keys: Ctrl/⌘+M three planes, Ctrl/⌘+Shift+M 3D.
            const mod = isMac() ? "⌘" : "Ctrl";
            const extra = !props.readingKeys ? null : value === "mpr" ? `${mod}+M` : value === "3d" ? `${mod}+Shift+M` : null;
            const keys = baseKeys || extra ? [...(baseKeys ?? []), ...(extra ? [extra] : [])] : null;
            const on =
              value === "stack" ? viewMode === "stack" : viewMode === "mpr" && mprRender === value;
            return (
              <Tooltip key={value} label={tip} shortcut={keys ? [...keys] : null} container={host}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={!ready}
                  onClick={() =>
                    value === "stack" ? props.onViewMode("stack") : props.onMprRender(value)
                  }
                  className={cn(
                    "h-8 rounded px-2.5 text-xs font-semibold tracking-wide [@media(pointer:coarse)]:h-10 group-data-[dense=true]/tb:px-2",
                    pressable,
                    on ? "bg-white/15 text-white" : "text-white/60 hover:text-white"
                  )}
                >
                  {label}
                </button>
              </Tooltip>
            );
          })}
        </div>

        {props.plane && props.onPlane && mprRender !== "3d" ? (
          <Menu
            label="Plane"
            container={host}
            trigger={
              <button
                type="button"
                disabled={!ready}
                aria-label={`Plane, ${PLANE_LABEL[props.plane]}`}
                data-testid="plane-switch"
                className={cn(
                  "ml-1 inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1.5 text-xs font-medium [@media(pointer:coarse)]:h-11",
                  pressable,
                  props.plane === "acquired" || props.plane === "all" ? idle : "bg-white/10 text-white"
                )}
              >
                <span className="max-w-[6rem] truncate">{PLANE_LABEL[props.plane]}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-70" strokeWidth={2} aria-hidden="true" />
              </button>
            }
          >
            <MenuLabel>Show this series as</MenuLabel>
            <MenuItem
              label="Acquired"
              hint="Original images"
              active={props.plane === "acquired"}
              onSelect={() => props.onPlane?.("acquired")}
            />
            <MenuSeparator />
            {(["axial", "coronal", "sagittal"] as const).map((plane) => (
              <MenuItem
                key={plane}
                label={PLANE_LABEL[plane]}
                hint="Reformatted"
                // Alt+A / C / S, as on the desktop (the same toggle: again for the acquired stack).
                shortcut={props.readingKeys ? `${isMac() ? "⌥" : "Alt"}+${plane[0]!.toUpperCase()}` : null}
                active={props.plane === plane}
                onSelect={() => props.onPlane?.(plane)}
              />
            ))}
            <MenuSeparator />
            <MenuItem
              label="All three planes"
              hint="MPR"
              active={props.plane === "all"}
              onSelect={() => props.onPlane?.("all")}
            />
          </Menu>
        ) : null}
        {props.onRecon && (
          <ToolbarButton label="Oblique, slab and curved MPR" disabled={!ready} container={host} pressed={false} onClick={props.onRecon}>
            <Icon as={Route} />
          </ToolbarButton>
        )}
        {props.onFusion && (
          <ToolbarButton label="PET / CT fusion" disabled={!ready} container={host} pressed={false} onClick={props.onFusion}>
            <Icon as={Combine} />
          </ToolbarButton>
        )}

        <Divider />

        {(viewMode === "mpr" ? [CROSSHAIRS_TOOL, ...NAV_TOOLS] : NAV_TOOLS).map((tool) => (
          <ToolbarButton
            key={tool.name}
            label={tool.label}
            shortcut={keysOf(shortcutForToolIn(tool.name, !!props.readingKeys))}
            active={activeTool === tool.name}
            disabled={!ready}
            container={host}
            onClick={() => props.onSelectTool(tool.name)}
          >
            <Icon as={TOOL_ICONS[tool.name]!} />
          </ToolbarButton>
        ))}

        <Divider />

        {/* Measure split: the face is the last-used measurement. */}
        <div className="flex shrink-0 items-center">
          <ToolbarButton
            label={blockedReason ? `${activeMeasure.label} — ${blockedReason}` : activeMeasure.label}
            shortcut={keysOf(shortcutForToolIn(activeMeasure.name, !!props.readingKeys))}
            active={measureActive}
            disabled={!ready || measureBlocked(activeMeasure)}
            container={host}
            onClick={() => props.onSelectTool(activeMeasure.name)}
            className="rounded-r-none"
          >
            <Icon as={TOOL_ICONS[activeMeasure.name]!} />
          </ToolbarButton>
          <Menu
            label="Measurement tools"
            container={host}
            open={measureOpen}
            onOpenChange={setMeasureOpen}
            trigger={
              <button
                type="button"
                aria-label="More measurement tools"
                disabled={!ready}
                className={cn(
                  "inline-flex h-9 w-5 items-center justify-center rounded-md rounded-l-none [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-7",
                  pressable,
                  measureOpen ? "bg-white/10 text-white" : idle
                )}
              >
                <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              </button>
            }
          >
            <MenuLabel>Measure</MenuLabel>
            {measureTools.map((tool) => (
              <MenuItem
                key={tool.name}
                label={tool.label}
                hint={measureBlocked(tool) ? (measurementsEnabled ? "no spacing" : "stack only") : undefined}
                shortcut={shortcutForToolIn(tool.name, !!props.readingKeys)?.split(" · ").pop() ?? null}
                active={activeTool === tool.name}
                disabled={!ready || measureBlocked(tool)}
                onSelect={() => props.onSelectTool(tool.name)}
              />
            ))}
          </Menu>
        </div>
        {props.textBox && (
          <ToolbarButton
            label="Text box (saved in this browser)"
            active={props.textBox.active}
            disabled={!ready || !measurementsEnabled}
            container={host}
            onClick={props.textBox.onToggle}
          >
            <Icon as={Type} />
          </ToolbarButton>
        )}
        {props.onSaveAnnotated && (
          <ToolbarButton
            label="Save image with annotations (PNG)"
            disabled={!ready || !measurementsEnabled}
            container={host}
            pressed={false}
            onClick={props.onSaveAnnotated}
          >
            <Icon as={ImageDown} />
          </ToolbarButton>
        )}
        {props.onMeasurements && (
          <ToolbarButton label="Measurements (list, copy as report text)" disabled={!ready} container={host} pressed={false} onClick={props.onMeasurements}>
            <Icon as={ListOrdered} />
          </ToolbarButton>
        )}
        {props.onExport && (
          <ToolbarButton
            label="Export images, video or DICOM"
            disabled={!ready}
            container={host}
            pressed={false}
            onClick={props.onExport}
          >
            <Icon as={Download} />
          </ToolbarButton>
        )}

        <Divider />

        <Menu
          label="Window presets"
          container={host}
          trigger={
            <button
              type="button"
              disabled={!ready || previewLocked}
              title={previewLocked ? "Window presets unlock when full-quality pixels load" : `Window: ${presetName}`}
              aria-label={
                previewLocked
                  ? "Window presets — unlock when full-quality pixels load"
                  : `Window presets, ${presetName}`
              }
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1.5 text-xs font-medium [@media(pointer:coarse)]:h-11",
                pressable,
                activePreset && activePreset !== FULL_DYNAMIC_ID ? "bg-white/10 text-white" : idle
              )}
            >
              <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              {/* Dense: the name moves to the tooltip and the overlay's window line. */}
              <span className="max-w-[5.5rem] truncate group-data-[dense=true]/tb:hidden">{presetName}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-70" strokeWidth={2} aria-hidden="true" />
            </button>
          }
        >
          <MenuLabel>Window</MenuLabel>
          <MenuItem
            label="Series default"
            hint="DICOM"
            shortcut={shortcutForPreset(0)}
            active={activePreset === FULL_DYNAMIC_ID}
            onSelect={() => props.onPreset(null)}
          />
          <MenuSeparator />
          {presets.map((p, i) => (
            <MenuItem
              key={p.id}
              label={p.label}
              hint={`${p.ww} / ${p.wc}`}
              shortcut={i < 9 ? shortcutForPreset(i + 1) : null}
              active={activePreset === p.id}
              onSelect={() => props.onPreset(p)}
            />
          ))}
          {props.onCustomWindow && (
            <>
              <MenuSeparator />
              <MenuItem
                label="Set window…"
                hint="exact WW / WL"
                shortcut="Ctrl+F11"
                active={activePreset === "custom"}
                onSelect={props.onCustomWindow}
              />
            </>
          )}
        </Menu>

        <ToolbarButton
          label={inverted ? "Invert (on)" : "Invert"}
          shortcut={["I"]}
          active={inverted}
          disabled={!ready}
          container={host}
          onClick={props.onInvert}
        >
          <Icon as={SunMoon} />
        </ToolbarButton>

        {cineOffered ? (
          <>
            <Divider />
            <ToolbarButton
              label={cinePlaying ? "Pause cine" : "Play cine"}
              shortcut={["K"]}
              active={cinePlaying}
              disabled={!ready}
              container={host}
              onClick={props.onCineToggle}
            >
              <Icon as={cinePlaying ? Pause : Play} />
            </ToolbarButton>
            <Menu
              label="Cine frame rate"
              container={host}
              trigger={
                <button
                  type="button"
                  disabled={!ready}
                  aria-label={`Cine frame rate, ${cineFps} frames per second`}
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center rounded-md px-1.5 text-xs font-medium tabular-nums [@media(pointer:coarse)]:h-11",
                    pressable,
                    idle
                  )}
                >
                  {cineFps}
                  <span className="ml-0.5 text-white/50">fps</span>
                </button>
              }
            >
              <MenuLabel>Frame rate</MenuLabel>
              {CINE_FPS_OPTIONS.map((fps) => (
                <MenuItem
                  key={fps}
                  label={`${fps} fps`}
                  active={fps === cineFps}
                  onSelect={() => props.onCineFps(fps)}
                />
              ))}
            </Menu>
          </>
        ) : null}

        <span aria-hidden="true" className="min-w-2 flex-1" />

        <Menu
          label="Rotate and flip"
          container={host}
          trigger={
            <button
              type="button"
              disabled={!ready || viewMode === "mpr"}
              aria-label="Rotate and flip"
              title="Rotate / flip · R, Shift+R, H, V"
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-0.5 rounded-md pl-2 pr-1 [@media(pointer:coarse)]:h-11",
                pressable,
                idle
              )}
            >
              <Icon as={RotateCw} />
              <ChevronDown className="h-3.5 w-3.5 opacity-70" strokeWidth={2} aria-hidden="true" />
            </button>
          }
        >
          <MenuLabel>Rotate / flip</MenuLabel>
          {ORIENTATION_COMMANDS.map((entry) => (
            <Fragment key={entry.command}>
              {(entry.command === "flip:h" || entry.command === "orient:reset") && <MenuSeparator />}
              <MenuItem
                label={entry.label}
                shortcut={entry.shortcut ? entry.shortcut.replace("Shift+", "⇧") : null}
                onSelect={() => props.onOrientation(entry.command)}
              />
            </Fragment>
          ))}
        </Menu>
        <ToolbarButton
          label="Reset view"
          shortcut={["0"]}
          pressed={null}
          disabled={!ready}
          container={host}
          onClick={props.onReset}
        >
          <Icon as={RotateCcw} />
        </ToolbarButton>
        <ToolbarButton
          label="Clear measurements"
          pressed={null}
          disabled={!ready}
          container={host}
          onClick={props.onClear}
        >
          <Icon as={Eraser} />
        </ToolbarButton>

        <Divider />

        <ToolbarButton
          label={overlayLabel}
          shortcut={["O"]}
          active={false}
          pressed={overlay !== "off"}
          disabled={!ready}
          container={host}
          onClick={props.onOverlay}
          className={overlay === "off" ? "text-white/45" : undefined}
        >
          <Icon as={overlay === "off" ? CaptionsOff : Captions} />
        </ToolbarButton>
        {props.voice && (
          <ToolbarButton
            label={props.voice.state === "listening" ? "Voice commands on" : props.voice.state === "loading" ? "Starting voice commands" : "Voice commands"}
            pressed={props.voice.state === "listening"}
            container={host}
            onClick={props.voice.onToggle}
            onWarm={props.voice.onWarm}
            className={props.voice.state === "listening" ? "bg-accent text-accent-foreground hover:bg-accent" : undefined}
          >
            <Icon as={props.voice.state === "listening" ? Mic : MicOff} />
          </ToolbarButton>
        )}
        {props.voice && props.onVoiceHelp && (
          <ToolbarButton
            label="Show voice commands"
            shortcut={props.voice.state === "listening" ? ["?"] : undefined}
            pressed={null}
            container={host}
            onClick={props.onVoiceHelp}
          >
            <Icon as={MessageSquareText} />
          </ToolbarButton>
        )}
        <ToolbarButton
          label="Keyboard & mouse"
          shortcut={["?"]}
          pressed={null}
          container={host}
          onClick={props.onHelp}
        >
          <Icon as={Keyboard} />
        </ToolbarButton>
        {stage ? (
          <ToolbarButton
            label={stage.expanded ? "Exit full screen" : "Full screen"}
            shortcut={stage.expanded ? ["F", "Esc"] : ["F"]}
            pressed={stage.expanded}
            container={host}
            onClick={stage.toggle}
          >
            <Icon as={stage.expanded ? Minimize2 : Maximize2} />
          </ToolbarButton>
        ) : null}
      </div>
      </div>
      {/* More tools than room (a phone, a narrow pane): the cut edge says so,
          and a tap pages the row. Every control stays in the row itself. */}
      {edges.left ? <ScrollEdge side="left" onPage={() => page(-1)} /> : null}
      {edges.right ? <ScrollEdge side="right" onPage={() => page(1)} /> : null}
    </div>
  );
}

function ScrollEdge({ side, onPage }: { side: "left" | "right"; onPage: () => void }) {
  const Chevron = side === "left" ? ChevronLeft : ChevronRight;
  const fade = (
    <span
      aria-hidden="true"
      className={cn("h-full w-5 from-black to-transparent", side === "left" ? "bg-gradient-to-r" : "bg-gradient-to-l")}
    />
  );
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-y-0 flex items-stretch",
        side === "left" ? "left-0 flex-row-reverse" : "right-0"
      )}
    >
      {fade}
      <span className="flex items-center bg-black px-0.5">
        <button
          type="button"
          // The row's own buttons are in the tab order and scroll into view on
          // focus; this is the pointer / touch affordance.
          tabIndex={-1}
          aria-label={side === "left" ? "Earlier tools" : "More tools"}
          data-testid={`toolbar-more-${side}`}
          onClick={onPage}
          className={cn(
            "pointer-events-auto inline-flex h-9 w-7 items-center justify-center rounded-md [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-8",
            pressable,
            idle
          )}
        >
          <Chevron className="h-4 w-4" strokeWidth={2.25} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}

/**
 * Fit the one-row toolbar to its pane. With a fine pointer the row first goes
 * dense (32 px icon buttons, the window name in the tooltip) — enough for the
 * full free-viewer set beside the series panel at 1440 px. When even that
 * overflows (phones, split panes) the row scrolls and the cut edges show a
 * chevron. Measured, not breakpoint-guessed: the row's contents vary by mode
 * and product.
 */
function useToolbarFit() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [dense, setDense] = useState(false);
  const [edges, setEdges] = useState({ left: false, right: false });
  // Width the row needed at full size when it went dense: un-dense only once
  // the pane can hold that again, so the row never flickers between the two.
  const fullWidth = useRef(0);

  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    const row = rowRef.current;
    if (!scroller || !row) return;
    const room = scroller.clientWidth;
    const need = row.scrollWidth;
    const fine = typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches;
    setDense((was) => {
      if (!was && fine && need > room + 1) {
        fullWidth.current = need;
        return true;
      }
      if (was && (!fine || room >= fullWidth.current)) return false;
      return was;
    });
    const left = scroller.scrollLeft > 1;
    const right = scroller.scrollLeft + room < scroller.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);

  // Measured on resize only (the row is `w-max`, so a control appearing or
  // going resizes it too), never on every render: reading scrollWidth forces
  // a layout, and the toolbar re-renders often while a volume is building.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const row = rowRef.current;
    if (!scroller || !row) return;
    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(scroller);
    observer.observe(row);
    scroller.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", measure);
    };
  }, [measure]);

  const page = useCallback((direction: 1 | -1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollBy({ left: direction * scroller.clientWidth * 0.75, behavior: reduce ? "auto" : "smooth" });
  }, []);

  return { scrollerRef, rowRef, dense, edges, page };
}
