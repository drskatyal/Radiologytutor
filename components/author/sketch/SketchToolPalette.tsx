"use client";

// Floating sketch palette on the Studio's imaging surface (pure black, so the
// imaging variant of IconButton). Each tool shows its Studio shortcut.

import {
  ArrowUpRight,
  Circle,
  Download,
  Eraser,
  MapPin,
  MoreHorizontal,
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
  inline = false,
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
  /**
   * `inline`: a group on the viewer's own toolbar (the Studio) — no "viewer
   * tools" button (picking any viewer tool does that) and a second click on
   * the active tool hands the pointer back to the viewer.
   */
  inline?: boolean;
}) {
  const side = inline ? "top" : "right";
  const tools = inline ? TOOLS.filter((t) => t.tool !== "select") : TOOLS;
  return (
    <div
      role="group"
      aria-label="Teaching ink"
      data-imaging-chrome
      data-testid="sketch-palette"
      className={cn(
        "pointer-events-auto flex items-center gap-1",
        inline ? "shrink-0 flex-row" : "flex-col rounded-xl bg-black/75 p-1 shadow-lg ring-1 ring-white/15 backdrop-blur-md"
      )}
    >
      {tools.map(({ tool: t, label, icon }) => {
        const active = tool === t;
        return (
          <Tooltip key={t} label={label} shortcut={[STUDIO_TOOL_SHORTCUT[t]]} side={side} container={container}>
            <IconButton
              variant="imaging"
              size="sm"
              aria-label={label}
              aria-pressed={active}
              data-tool={t}
              disabled={disabled}
              onClick={() => onTool(inline && active ? "select" : t)}
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
      {inline ? (
        // On the viewer's toolbar space is tight: the ink actions share one menu.
        <Menu
          side="top"
          align="end"
          label="Ink actions"
          contentClassName="w-72"
          container={container}
          trigger={
            <IconButton
              variant="imaging"
              size="sm"
              aria-label="Ink actions: undo, redo, clear, export"
              loading={exporting}
              disabled={disabled}
              className="border-transparent bg-transparent"
            >
              <MoreHorizontal />
            </IconButton>
          }
        >
          <MenuItem label="Undo" shortcut="⌘Z" disabled={!canUndo} onSelect={onUndo} />
          <MenuItem label="Redo" shortcut="⌘⇧Z" disabled={!canRedo} onSelect={onRedo} />
          <MenuItem label="Clear all ink" disabled={!hasInk} onSelect={onClear} />
          {onExport && (
            <>
              <MenuSeparator />
              <MenuItem label="Export DICOM SR (TID 1500)" hint="Opens in OHIF" disabled={!hasInk || exporting} onSelect={() => onExport("sr")} />
              <MenuItem label="Export DICOM GSPS" hint="Presentation state" disabled={!hasInk || exporting} onSelect={() => onExport("gsps")} />
              <MenuItem label="Export JSON sidecar" hint="Timing + narration links" disabled={!hasInk || exporting} onSelect={() => onExport("json")} />
            </>
          )}
        </Menu>
      ) : (
        <>
        <span className="my-0.5 h-px w-5 bg-white/15" aria-hidden="true" />
        <Tooltip label="Undo" shortcut={["⌘Z", "U"]} side={side} container={container}>
          <IconButton variant="imaging" size="sm" aria-label="Undo" disabled={disabled || !canUndo} onClick={onUndo} className="border-transparent bg-transparent">
            <Undo2 />
          </IconButton>
        </Tooltip>
        <Tooltip label="Redo" shortcut={["⌘⇧Z"]} side={side} container={container}>
          <IconButton variant="imaging" size="sm" aria-label="Redo" disabled={disabled || !canRedo} onClick={onRedo} className="border-transparent bg-transparent">
            <Redo2 />
          </IconButton>
        </Tooltip>
        <Tooltip label="Clear all ink" side={side} container={container}>
          <IconButton variant="imaging" size="sm" aria-label="Clear all ink" disabled={disabled || !hasInk} onClick={onClear} className="border-transparent bg-transparent hover:text-danger">
            <Trash2 />
          </IconButton>
        </Tooltip>
        {onExport && (
          <Menu
            side={side}
            align="end"
            label="Export marks as DICOM"
            contentClassName="w-80"
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
        </>
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
