// The monitor picker shown over a series card while it is held or dragged:
// one numbered, coloured tile per monitor, laid out like the desk. Drop on a
// tile to open the series on that monitor. Colours match the badge on each
// monitor's window (MonitorBadge).

import type { MonitorPickerState } from "../viewer/seriesDrag";

export function MonitorPicker({ picker }: { picker: MonitorPickerState }) {
  const hovered = picker.tiles.find((t) => t.name === picker.hover);
  return (
    <div
      role="dialog"
      aria-label="Open on monitor"
      data-testid="monitor-picker"
      className="pointer-events-none fixed z-[60] rounded-lg border border-strong bg-canvas/95 shadow-xl backdrop-blur-sm animate-in fade-in zoom-in-95 duration-100"
      // Dynamic geometry: over the series card that was pressed.
      style={{ left: picker.left, top: picker.top, width: picker.width, height: picker.height }}
    >
      {picker.tiles.map((t) => {
        const on = t.name === picker.hover;
        return (
          <div
            key={t.name}
            data-testid="monitor-tile"
            data-monitor={t.name}
            data-number={t.number}
            data-hover={on ? "1" : undefined}
            className={`absolute flex items-center justify-center rounded-md text-lg font-semibold tabular-nums text-white transition-transform duration-75 ${
              on ? "scale-105 ring-2 ring-white" : "opacity-85"
            }`}
            // Dynamic geometry + this monitor's colour (shared with its window badge).
            style={{ left: t.left, top: t.top, width: t.width, height: t.height, backgroundColor: t.color }}
          >
            {t.number}
          </div>
        );
      })}
      <span className="absolute inset-x-2 bottom-1 truncate text-center text-[11px] font-medium leading-4 text-secondary">
        {hovered ? `Open on monitor ${hovered.number}` : "Drop on a monitor · Esc cancels"}
      </span>
    </div>
  );
}

/** Which monitor this window is on: the same number and colour as its picker tile. */
export function MonitorBadge({ number, color }: { number: number; color: string }) {
  return (
    <span
      data-testid="monitor-badge"
      data-number={number}
      title={`Monitor ${number}`}
      aria-label={`Monitor ${number}`}
      className="inline-flex h-5 min-w-5 items-center justify-center rounded px-1 text-[11px] font-semibold tabular-nums text-white"
      // This monitor's colour (shared with its picker tile).
      style={{ backgroundColor: color }}
    >
      {number}
    </span>
  );
}
