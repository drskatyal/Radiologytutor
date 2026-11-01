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

import { useContext, useEffect, useState, type ReactNode } from "react";
import {
  Blend,
  Captions,
  CaptionsOff,
  ChevronDown,
  Circle,
  Crosshair,
  Eraser,
  Keyboard,
  Layers,
  LocateFixed,
  Maximize2,
  Minimize2,
  Move,
  MoveUpRight,
  Pause,
  Play,
  RotateCcw,
  Ruler,
  SlidersHorizontal,
  Square,
  SunMoon,
  Triangle,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import { Menu, MenuItem, MenuLabel, MenuSeparator, Tooltip } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { CINE_FPS_OPTIONS } from "@/lib/cinePlayer";
import type { OverlayDensity } from "@/lib/dicomOverlay";
import { shortcutForTool } from "@/lib/viewerHotkeys";
import type { MprMode, MprRender } from "@/lib/mpr";
import { FULL_DYNAMIC_ID, type WindowPreset } from "@/lib/windowPresets";
import { ImagingStageContext } from "./stageContext";

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
];

export const PRIMARY_TOOLS: ViewerTool[] = [...NAV_TOOLS, ...MEASURE_TOOLS];

export function toolLabel(name: string): string {
  return PRIMARY_TOOLS.find((t) => t.name === name)?.label ?? name;
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
const square = "h-9 w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11";

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
}: {
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
  return <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-white/10" />;
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
  cineOffered: boolean;
  cinePlaying: boolean;
  cineFps: number;
  overlay: OverlayDensity;
  onSelectTool: (name: string) => void;
  onPreset: (preset: WindowPreset | null) => void;
  onInvert: () => void;
  onReset: () => void;
  onClear: () => void;
  onViewMode: (mode: MprMode) => void;
  onCineToggle: () => void;
  onCineFps: (fps: number) => void;
  onOverlay: () => void;
  onHelp: () => void;
}

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
  } = props;
  const host = usePortalHost();
  const [measureOpen, setMeasureOpen] = useState(false);
  const stage = useContext(ImagingStageContext);
  const claimStage = stage?.claim;
  useEffect(() => claimStage?.(), [claimStage]);

  const activeMeasure = MEASURE_TOOLS.find((t) => t.name === activeTool) ?? MEASURE_TOOLS[0]!;
  const measureActive = MEASURE_TOOLS.some((t) => t.name === activeTool);
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

  return (
    <div
      className={cn(
        // The scroller is a block, not the flex row: a flex row that is also
        // the scroller reports its content width to the page and opens a
        // horizontal scrollbar on narrow stages.
        "w-full min-w-0 max-w-full touch-pan-x overflow-x-auto overscroll-x-contain bg-black text-white",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        variant === "edge"
          ? "border-t border-[#1F1F1F]"
          : "rounded-lg border border-[#1F1F1F]"
      )}
    >
      <div
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
          ).map(([value, label, tip, keys]) => {
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
                    "h-8 rounded px-2.5 text-xs font-semibold tracking-wide [@media(pointer:coarse)]:h-10",
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

        <Divider />

        {(viewMode === "mpr" ? [CROSSHAIRS_TOOL, ...NAV_TOOLS] : NAV_TOOLS).map((tool) => (
          <ToolbarButton
            key={tool.name}
            label={tool.label}
            shortcut={keysOf(shortcutForTool(tool.name))}
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
            shortcut={keysOf(shortcutForTool(activeMeasure.name))}
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
            {MEASURE_TOOLS.map((tool) => (
              <MenuItem
                key={tool.name}
                label={tool.label}
                hint={measureBlocked(tool) ? (measurementsEnabled ? "no spacing" : "stack only") : undefined}
                shortcut={shortcutForTool(tool.name)?.split(" · ").pop() ?? null}
                active={activeTool === tool.name}
                disabled={!ready || measureBlocked(tool)}
                onSelect={() => props.onSelectTool(tool.name)}
              />
            ))}
          </Menu>
        </div>

        <Divider />

        <Menu
          label="Window presets"
          container={host}
          trigger={
            <button
              type="button"
              disabled={!ready || previewLocked}
              title={previewLocked ? "Window presets unlock when full-quality pixels load" : undefined}
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
              <span className="max-w-[5.5rem] truncate">{presetName}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-70" strokeWidth={2} aria-hidden="true" />
            </button>
          }
        >
          <MenuLabel>Window</MenuLabel>
          <MenuItem
            label="Series default"
            hint="DICOM"
            shortcut="⇧0"
            active={activePreset === FULL_DYNAMIC_ID}
            onSelect={() => props.onPreset(null)}
          />
          <MenuSeparator />
          {presets.map((p, i) => (
            <MenuItem
              key={p.id}
              label={p.label}
              hint={`${p.ww} / ${p.wc}`}
              shortcut={i < 9 ? `⇧${i + 1}` : null}
              active={activePreset === p.id}
              onSelect={() => props.onPreset(p)}
            />
          ))}
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
        <ToolbarButton
          label="Keyboard & mouse"
          shortcut={["H"]}
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
  );
}
