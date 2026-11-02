"use client";

// Floating sketch palette on the Studio's imaging surface (pure black, so the
// imaging variant of IconButton). Each tool shows its Studio shortcut.

import {
  ArrowUpRight,
  Circle,
  Download,
  Eraser,
  MapPin,
  MousePointer2,
  PenLine,
  Redo2,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import type { ReactNode } from "react";
import { IconButton, Kbd, Menu, MenuItem, MenuSeparator, Tooltip, cn } from "@/components/ui";
import { STUDIO_TOOL_SHORTCUT } from "@/lib/studioHotkeys";
import type { TeacherSketchTool } from "@/lib/teacherSketch";

export type SketchExportFormat = "sr" | "gsps" | "json";

const TOOLS: { tool: TeacherSketchTool; label: string; icon: ReactNode }[] = [
  { tool: "select", label: "Viewer tools", icon: <MousePointer2 /> },
  { tool: "pen", label: "Pen", icon: <PenLine /> },
  { tool: "arrow", label: "Arrow", icon: <ArrowUpRight /> },
  { tool: "ellipse", label: "Ellipse (Shift for circle)", icon: <Circle /> },
  { tool: "text", label: "Text", icon: <Type /> },
  { tool: "marker", label: "Finding marker", icon: <MapPin /> },
  { tool: "eraser", label: "Eraser", icon: <Eraser /> },
];

export function SketchToolPalette({
  tool,
  onTool,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
  hasInk,
  disabled,
  onExport,
  exporting,
  container,
}: {
  tool: TeacherSketchTool;
  onTool: (tool: TeacherSketchTool) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  hasInk: boolean;
  /** Replay owns the layer. */
  disabled?: boolean;
  onExport?: (format: SketchExportFormat) => void;
  exporting?: boolean;
  /** Portal target so tooltips survive fullscreen. */
  container?: HTMLElement | null;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Sketch tools"
      aria-orientation="vertical"
      data-imaging-chrome
      data-testid="sketch-palette"
      className="pointer-events-auto flex flex-col items-center gap-1 rounded-xl bg-black/75 p-1 shadow-lg ring-1 ring-white/15 backdrop-blur-md"
    >
      {TOOLS.map(({ tool: t, label, icon }) => {
        const active = tool === t;
        return (
          <Tooltip key={t} label={label} shortcut={[STUDIO_TOOL_SHORTCUT[t]]} side="right" container={container}>
            <IconButton
              variant="imaging"
              size="sm"
              aria-label={label}
              aria-pressed={active}
              data-tool={t}
              disabled={disabled}
              onClick={() => onTool(t)}
              className={cn(
                "border-transparent bg-transparent",
                active && "bg-ink text-black hover:bg-ink focus-visible:ring-ink"
              )}
            >
              {icon}
            </IconButton>
          </Tooltip>
        );
      })}
      <span className="my-0.5 h-px w-5 bg-white/15" aria-hidden="true" />
      <Tooltip label="Undo" shortcut={["⌘Z", "U"]} side="right" container={container}>
        <IconButton variant="imaging" size="sm" aria-label="Undo" disabled={disabled || !canUndo} onClick={onUndo} className="border-transparent bg-transparent">
          <Undo2 />
        </IconButton>
      </Tooltip>
      <Tooltip label="Redo" shortcut={["⌘⇧Z"]} side="right" container={container}>
        <IconButton variant="imaging" size="sm" aria-label="Redo" disabled={disabled || !canRedo} onClick={onRedo} className="border-transparent bg-transparent">
          <Redo2 />
        </IconButton>
      </Tooltip>
      <Tooltip label="Clear all ink" side="right" container={container}>
        <IconButton variant="imaging" size="sm" aria-label="Clear all ink" disabled={disabled || !hasInk} onClick={onClear} className="border-transparent bg-transparent hover:text-danger">
          <Trash2 />
        </IconButton>
      </Tooltip>
      {onExport && (
        <Menu
          side="right"
          align="end"
          label="Export marks as DICOM"
          container={container}
          trigger={
            <IconButton variant="imaging" size="sm" aria-label="Export marks" loading={exporting} disabled={!hasInk || exporting} className="border-transparent bg-transparent">
              <Download />
            </IconButton>
          }
        >
          <MenuItem label="DICOM SR (TID 1500)" hint="Opens in OHIF" onSelect={() => onExport("sr")} />
          <MenuItem label="DICOM GSPS" hint="Presentation state" onSelect={() => onExport("gsps")} />
          <MenuSeparator />
          <MenuItem label="JSON sidecar" hint="Timing + narration links" onSelect={() => onExport("json")} />
        </Menu>
      )}
    </div>
  );
}

const HINT: { keys: string; does: string }[] = [
  { keys: "M", does: "marker" },
  { keys: "D", does: "pen" },
  { keys: "A", does: "arrow" },
  { keys: "O", does: "ellipse" },
  { keys: "Q", does: "text" },
  { keys: "E", does: "eraser" },
  { keys: "U", does: "undo" },
  { keys: "V", does: "viewer tools" },
];

/** One-line reminder under the transport: draw while you narrate. */
export function SketchShortcutHint({ className }: { className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted", className)}>
      <span className="font-medium text-secondary">Draw while you narrate</span>
      {HINT.map((h) => (
        <span key={h.keys} className="inline-flex items-center gap-1">
          <Kbd>{h.keys}</Kbd>
          {h.does}
        </span>
      ))}
    </p>
  );
}
