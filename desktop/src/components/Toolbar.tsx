// The viewer toolbar. Every button maps to a keyboard shortcut (shown in its
// tooltip) and acts on the active viewport.

import type { ReactNode } from "react";
import {
  ArrowUpRight,
  Box,
  Circle,
  Columns2,
  Contrast,
  Download,
  FolderOpen,
  Hand,
  HelpCircle,
  Home,
  Layers3,
  LayoutGrid,
  Link2,
  Maximize,
  MousePointer2,
  Move3d,
  Pause,
  PenLine,
  Play,
  RotateCcw,
  RotateCw,
  Ruler,
  ScanSearch,
  Search,
  Settings,
  Square,
  SunMedium,
  Triangle,
  Crosshair,
  Eye,
  EyeOff,
  Disc3,
  FileArchive,
  Files,
  FolderTree,
  Undo2,
  Trash2,
  Merge,
  ZoomIn,
  Spline,
  Pipette,
} from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/components/ui/cn";
import type { WindowPreset } from "@/lib/windowPresets";
import { MenuContent, MenuItem, MenuLabel, MenuRoot, MenuSeparator, MenuTrigger } from "./Menu";
import { LAYOUT_SHORTCUTS, isMac } from "../shortcuts";

export interface ToolbarProps {
  leftTool: string;
  onTool: (tool: string) => void;
  presets: WindowPreset[];
  onPreset: (preset: WindowPreset | null) => void;
  onCustomWindow: () => void;
  onInvert: () => void;
  onReset: () => void;
  onRotate: (deg: number) => void;
  layout: { rows: number; cols: number };
  onLayout: (rows: number, cols: number) => void;
  syncScroll: boolean;
  onToggleSync: () => void;
  referenceLines: boolean;
  onToggleReferenceLines: () => void;
  overlay: boolean;
  onToggleOverlay: () => void;
  cine: { playing: boolean; fps: number };
  cineAvailable: boolean;
  onToggleCine: () => void;
  onCineFps: (fps: number) => void;
  onOpen: (what: "files" | "folder" | "disc" | "zip" | "dicomdir") => void;
  onHome: () => void;
  onUndo: () => void;
  onClear: () => void;
  onFullscreen: () => void;
  onHelp: () => void;
  onSettings: () => void;
  /** Advanced views; omitted when the build does not offer them. */
  advanced?: {
    mprAvailable: boolean;
    fusionAvailable: boolean;
    view: "grid" | "mpr" | "3d" | "fusion";
    onMpr: () => void;
    onVolume: () => void;
    onFusion: () => void;
  };
  onExport?: () => void;
}

const mod = isMac() ? "⌘" : "Ctrl+";

function Tool({
  label,
  shortcut,
  active,
  onClick,
  children,
  disabled,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <IconButton
      aria-label={shortcut ? `${label} (${shortcut})` : label}
      title={shortcut ? `${label}  ·  ${shortcut}` : label}
      aria-pressed={active}
      size="sm"
      disabled={disabled}
      onClick={onClick}
      className={cn("h-8 w-8 rounded-md", active && "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground")}
    >
      {children}
    </IconButton>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-subtle" />;
}

const MEASURE: { tool: string; label: string; key: string; icon: ReactNode }[] = [
  { tool: "Length", label: "Length", key: "L", icon: <Ruler /> },
  { tool: "Angle", label: "Angle", key: "A", icon: <Triangle /> },
  { tool: "CobbAngle", label: "Cobb angle", key: "C", icon: <Spline /> },
  { tool: "EllipticalROI", label: "Ellipse ROI", key: "E", icon: <Circle /> },
  { tool: "RectangleROI", label: "Rectangle ROI", key: "R", icon: <Square /> },
  { tool: "PlanarFreehandROI", label: "Freehand ROI", key: "P", icon: <PenLine /> },
  { tool: "Probe", label: "Pixel probe", key: "X", icon: <Pipette /> },
  { tool: "ArrowAnnotate", label: "Arrow", key: "Y", icon: <ArrowUpRight /> },
];

export function Toolbar(props: ToolbarProps) {
  const { leftTool, onTool } = props;
  const extraMeasure = [
    { tool: "CircleROI", label: "Circle ROI", key: "O", icon: <Circle /> },
    { tool: "Bidirectional", label: "Bidirectional", key: "D", icon: <Crosshair /> },
    { tool: "Magnify", label: "Magnifying glass", key: "G", icon: <Search /> },
  ];
  const extraActive = extraMeasure.find((m) => m.tool === leftTool);

  return (
    <div role="toolbar" aria-label="Viewer tools" className="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-subtle bg-surface px-2">
      <Tool label="Start screen" onClick={props.onHome}>
        <Home />
      </Tool>
      <MenuRoot>
        <MenuTrigger asChild>
          <IconButton aria-label="Open" title="Open…" size="sm" className="h-8 w-8 rounded-md">
            <FolderOpen />
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>Open</MenuLabel>
          <MenuItem icon={<FolderTree />} shortcut={`${mod}⇧O`} onSelect={() => props.onOpen("folder")}>Folder…</MenuItem>
          <MenuItem icon={<Files />} shortcut={`${mod}O`} onSelect={() => props.onOpen("files")}>Files…</MenuItem>
          <MenuItem icon={<FileArchive />} shortcut={`${mod}⇧Z`} onSelect={() => props.onOpen("zip")}>Zip archive…</MenuItem>
          <MenuItem icon={<FolderTree />} onSelect={() => props.onOpen("dicomdir")}>DICOMDIR…</MenuItem>
          <MenuItem icon={<Disc3 />} shortcut={`${mod}⌥O`} onSelect={() => props.onOpen("disc")}>CD / DVD / USB…</MenuItem>
        </MenuContent>
      </MenuRoot>
      <Divider />

      <Tool label="Browse slices" shortcut="B" active={leftTool === "StackScroll"} onClick={() => onTool("StackScroll")}>
        <MousePointer2 />
      </Tool>
      <Tool label="Window / level" shortcut="W · right drag" active={leftTool === "WindowLevel"} onClick={() => onTool("WindowLevel")}>
        <SunMedium />
      </Tool>
      <Tool label="Pan" shortcut="M · middle drag" active={leftTool === "Pan"} onClick={() => onTool("Pan")}>
        <Hand />
      </Tool>
      <Tool label="Zoom" shortcut={`Z · ${mod}wheel`} active={leftTool === "Zoom"} onClick={() => onTool("Zoom")}>
        <ZoomIn />
      </Tool>
      <Divider />
      {MEASURE.map((m) => (
        <Tool key={m.tool} label={m.label} shortcut={m.key} active={leftTool === m.tool} onClick={() => onTool(m.tool)}>
          {m.icon}
        </Tool>
      ))}
      <MenuRoot>
        <MenuTrigger asChild>
          <IconButton
            aria-label="More tools"
            title="More tools"
            size="sm"
            aria-pressed={!!extraActive}
            className={cn("h-8 w-8 rounded-md", extraActive && "bg-accent text-accent-foreground")}
          >
            {extraActive ? extraActive.icon : <ScanSearch />}
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          {extraMeasure.map((m) => (
            <MenuItem key={m.tool} icon={m.icon} shortcut={m.key} checked={leftTool === m.tool} onSelect={() => onTool(m.tool)}>
              {m.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon={<Undo2 />} shortcut={`${mod}Z`} onSelect={props.onUndo}>Undo last measurement</MenuItem>
          <MenuItem icon={<Trash2 />} shortcut={`${mod}⇧⌫`} onSelect={props.onClear}>Clear measurements</MenuItem>
        </MenuContent>
      </MenuRoot>
      <Divider />

      <MenuRoot>
        <MenuTrigger asChild>
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-secondary hover:bg-overlay hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            title="Window presets · 1–9"
          >
            <Contrast className="h-4 w-4" aria-hidden />
            Window
          </button>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>Window presets</MenuLabel>
          <MenuItem shortcut="0" onSelect={() => props.onPreset(null)}>Default (from file)</MenuItem>
          {props.presets.map((p, i) => (
            <MenuItem key={p.id} shortcut={i < 9 ? String(i + 1) : undefined} onSelect={() => props.onPreset(p)}>
              {p.label}
              <span className="ml-2 text-xs text-muted tabular-nums">
                {p.ww} / {p.wc}
              </span>
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem shortcut={`${mod}F11`} onSelect={props.onCustomWindow}>Custom W / L…</MenuItem>
          <MenuItem shortcut="I" onSelect={props.onInvert}>Invert</MenuItem>
        </MenuContent>
      </MenuRoot>
      <Tool label="Rotate left" shortcut="⇧Q" onClick={() => props.onRotate(-90)}>
        <RotateCcw />
      </Tool>
      <Tool label="Rotate right" shortcut="Q" onClick={() => props.onRotate(90)}>
        <RotateCw />
      </Tool>
      <Tool label="Reset view" shortcut="Backspace" onClick={props.onReset}>
        <Layers3 />
      </Tool>
      <Divider />

      <MenuRoot>
        <MenuTrigger asChild>
          <IconButton aria-label="Layout" title="Layout · ⇧1–7" size="sm" className="h-8 w-8 rounded-md">
            <LayoutGrid />
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>Viewport layout</MenuLabel>
          <div className="grid grid-cols-4 gap-1 p-1">
            {LAYOUT_SHORTCUTS.map((l, i) => {
              const current = props.layout.rows === l.rows && props.layout.cols === l.cols;
              return (
                <button
                  key={`${l.rows}x${l.cols}`}
                  type="button"
                  onClick={() => props.onLayout(l.rows, l.cols)}
                  title={`${l.rows} × ${l.cols}  ·  ⇧${i + 1}`}
                  aria-pressed={current}
                  className={cn(
                    "grid aspect-square w-11 gap-0.5 rounded-md border p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    current ? "border-accent bg-accent-muted/50" : "border-subtle hover:border-strong"
                  )}
                  // Dynamic grid shape for the picker glyph.
                  style={{ gridTemplateRows: `repeat(${l.rows}, 1fr)`, gridTemplateColumns: `repeat(${l.cols}, 1fr)` }}
                >
                  {Array.from({ length: l.rows * l.cols }, (_, k) => (
                    <span key={k} className={cn("rounded-[2px]", current ? "bg-accent" : "bg-strong")} />
                  ))}
                </button>
              );
            })}
          </div>
        </MenuContent>
      </MenuRoot>
      <Tool label="Synchronise scrolling" shortcut="F5" active={props.syncScroll} onClick={props.onToggleSync}>
        <Link2 />
      </Tool>
      <Tool label="Reference lines" shortcut={`${mod}F12`} active={props.referenceLines} onClick={props.onToggleReferenceLines}>
        <Columns2 />
      </Tool>
      <Divider />
      <Tool
        label={props.cine.playing ? "Pause cine" : "Play cine"}
        shortcut="Space"
        active={props.cine.playing}
        disabled={!props.cineAvailable}
        onClick={props.onToggleCine}
      >
        {props.cine.playing ? <Pause /> : <Play />}
      </Tool>
      <label className="flex items-center gap-1 text-xs text-secondary" title="Cine speed · [ and ]">
        <span className="sr-only">Cine frames per second</span>
        <select
          value={props.cine.fps}
          onChange={(e) => props.onCineFps(Number(e.target.value))}
          disabled={!props.cineAvailable}
          className="h-7 rounded-md border border-subtle bg-elevated px-1 text-xs text-primary tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        >
          {[5, 10, 15, 20, 25, 30, 40, 60].concat(
            [5, 10, 15, 20, 25, 30, 40, 60].includes(props.cine.fps) ? [] : [props.cine.fps]
          ).map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
      </label>

      {props.advanced && (
        <>
          <Divider />
          <Tool
            label={props.advanced.view === "mpr" ? "Back to images" : "MPR"}
            shortcut={`${mod}M`}
            active={props.advanced.view === "mpr"}
            disabled={!props.advanced.mprAvailable}
            onClick={props.advanced.onMpr}
          >
            <Move3d />
          </Tool>
          <Tool
            label={props.advanced.view === "3d" ? "Back to images" : "3D volume rendering"}
            shortcut={`${mod}⇧M`}
            active={props.advanced.view === "3d"}
            disabled={!props.advanced.mprAvailable}
            onClick={props.advanced.onVolume}
          >
            <Box />
          </Tool>
          <Tool
            label={props.advanced.view === "fusion" ? "Back to images" : "PET / CT fusion"}
            shortcut={`${mod}⇧F`}
            active={props.advanced.view === "fusion"}
            disabled={!props.advanced.fusionAvailable}
            onClick={props.advanced.onFusion}
          >
            <Merge />
          </Tool>
        </>
      )}

      <div className="ml-auto flex items-center gap-0.5 pl-2">
        {props.onExport && (
          <Tool label="Export" shortcut={`${mod}E`} onClick={props.onExport}>
            <Download />
          </Tool>
        )}
        <Tool label={props.overlay ? "Hide overlay" : "Show overlay"} shortcut={`${mod}⇧F12`} active={!props.overlay} onClick={props.onToggleOverlay}>
          {props.overlay ? <Eye /> : <EyeOff />}
        </Tool>
        <Tool label="Full screen" shortcut="F" onClick={props.onFullscreen}>
          <Maximize />
        </Tool>
        <Tool label="Keyboard shortcuts" shortcut="F1" onClick={props.onHelp}>
          <HelpCircle />
        </Tool>
        <Tool label="Settings" onClick={props.onSettings}>
          <Settings />
        </Tool>
      </div>
    </div>
  );
}
