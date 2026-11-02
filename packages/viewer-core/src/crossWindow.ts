/**
 * Several viewer windows (desktop: one per monitor; web: popped-out tabs)
 * acting as one reading station.
 *
 * Pure parts only, shared by desktop and web: the messages the windows
 * exchange, the reference line a plane shown in another window draws on this
 * one, and where a remembered window goes on today's monitors. Transport is
 * the app's (Tauri events / BroadcastChannel).
 */

export type XVec3 = readonly [number, number, number];

/** What a window tells the others. `from` is the sender's window id. */
export type WindowSyncMessage =
  /** The active viewport moved to `z` along `normal` (shared frame, after registration offsets). */
  | { kind: "slice"; from: string; frame: string; normal: XVec3; z: number }
  | { kind: "voi"; from: string; ww: number; wc: number }
  | { kind: "zoom"; from: string; zoom: number }
  /** The active viewport's image plane, for reference lines elsewhere (corners in world mm). */
  | { kind: "plane"; from: string; frame: string; corners: readonly [XVec3, XVec3, XVec3, XVec3]; monitorIndex?: number }
  /** Which links are on (any window can toggle them for all). */
  | { kind: "links"; from: string; scroll: boolean; voi: boolean; zoom: boolean; referenceLines: boolean }
  /** A window's monitor and layout, so the main window can reuse it and remember it for next launch. */
  | { kind: "window-state"; from: string; monitor?: string; rows: number; cols: number; cells: (string | null)[]; studyKey?: string }
  /** Show a series in the active pane of window `to` (the picker's drop on a monitor that already has a window). */
  | { kind: "show-series"; from: string; to: string; seriesUid: string }
  | { kind: "closed"; from: string };

export function isWindowSyncMessage(value: unknown): value is WindowSyncMessage {
  const m = value as { kind?: unknown; from?: unknown } | null;
  return !!m && typeof m.from === "string" && ["slice", "voi", "zoom", "plane", "links", "window-state", "show-series", "closed"].includes(String(m.kind));
}

const sub = (a: XVec3, b: XVec3): XVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: XVec3, b: XVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a: XVec3, b: XVec3, t: number): XVec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Where another window's image plane cuts this viewport's plane: the segment
 * (world mm) to draw as a reference line, or null when the planes are
 * parallel (an axial on an axial) or do not meet inside the remote image.
 *
 * `corners` go round the remote image (top-left, top-right, bottom-right,
 * bottom-left); the segment is clipped to that image, as PACS reference
 * lines are.
 */
export function referenceSegment(
  local: { origin: XVec3; normal: XVec3 },
  corners: readonly [XVec3, XVec3, XVec3, XVec3]
): [XVec3, XVec3] | null {
  const side = corners.map((c) => dot(sub(c, local.origin), local.normal));
  // Parallel (or the same plane): every corner at the same signed distance.
  if (Math.max(...side) - Math.min(...side) < 1e-6) return null;
  const hits: XVec3[] = [];
  for (let i = 0; i < 4; i += 1) {
    const a = side[i];
    const b = side[(i + 1) % 4];
    if (a === 0) hits.push(corners[i]);
    else if (a * b < 0) hits.push(lerp(corners[i], corners[(i + 1) % 4], a / (a - b)));
  }
  const unique = hits.filter((p, i) => hits.findIndex((q) => Math.hypot(...sub(p, q)) < 1e-6) === i);
  return unique.length >= 2 ? [unique[0], unique[1]] : null;
}

/** A monitor as the OS reports it (physical pixels; `scale` = device pixels per CSS pixel). */
export interface MonitorInfo {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

/** A secondary window as remembered between launches. */
export interface WindowArrangement {
  monitor: MonitorInfo;
  rows: number;
  cols: number;
  /** Series UIDs per cell (null = empty), restored when the same study is open. */
  cells: (string | null)[];
  /** Which study the cells belong to (history key). */
  studyKey?: string;
}

/**
 * Where a remembered window opens today: on the monitor of the same name, or
 * failing that the same position in the monitor list; never off-screen. Null
 * when only one monitor is attached (the window would cover the main one).
 */
export function placeArrangement(saved: WindowArrangement, savedIndex: number, monitors: readonly MonitorInfo[], mainMonitorName?: string): MonitorInfo | null {
  if (monitors.length < 2) return null;
  const byName = monitors.find((m) => m.name === saved.monitor.name && m.name !== mainMonitorName);
  if (byName) return byName;
  const others = monitors.filter((m) => m.name !== mainMonitorName);
  return others[Math.min(savedIndex, others.length - 1)] ?? null;
}

/** The monitor after `current` (wraps), for "Send to next monitor". */
export function nextMonitor(monitors: readonly MonitorInfo[], currentName?: string): MonitorInfo | null {
  if (monitors.length < 2) return null;
  const i = monitors.findIndex((m) => m.name === currentName);
  return monitors[(i + 1) % monitors.length] ?? null;
}

/** "Monitor 2 · 2560×1440 @150%": how the menus name a monitor. */
export function monitorLabel(monitors: readonly MonitorInfo[], m: MonitorInfo): string {
  const n = monitors.findIndex((x) => x.name === m.name) + 1;
  return `Monitor ${n} · ${m.width}×${m.height}${m.scale !== 1 ? ` @${Math.round(m.scale * 100)}%` : ""}`;
}

/**
 * One colour per monitor, in the OS order: the picker tile and the badge on
 * that monitor's window share it, so "orange 2" means the same screen
 * everywhere. Distinct in hue and readable with white numerals.
 */
export const MONITOR_COLORS: readonly string[] = ["#16A34A", "#EA580C", "#2563EB", "#C026D3", "#0891B2", "#CA8A04"];

export function monitorColor(index: number): string {
  return MONITOR_COLORS[((index % MONITOR_COLORS.length) + MONITOR_COLORS.length) % MONITOR_COLORS.length];
}

export interface MonitorTile {
  name: string;
  /** 1-based, as the OS numbers them. */
  number: number;
  color: string;
  /** Position inside the picker box (CSS px). */
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Monitor-picker tiles laid out like the desk: each monitor's rectangle
 * scaled into a `box` (keeping proportions and left/right/above), with a small
 * gap so neighbours read as separate screens. Mixed resolutions keep their
 * relative sizes; the arrangement is in the OS's physical coordinates.
 */
export function monitorTiles(monitors: readonly MonitorInfo[], box: { width: number; height: number }, gap = 4): MonitorTile[] {
  if (!monitors.length) return [];
  const minX = Math.min(...monitors.map((m) => m.x));
  const minY = Math.min(...monitors.map((m) => m.y));
  const maxX = Math.max(...monitors.map((m) => m.x + m.width));
  const maxY = Math.max(...monitors.map((m) => m.y + m.height));
  const scale = Math.min(box.width / (maxX - minX), box.height / (maxY - minY));
  const offX = (box.width - (maxX - minX) * scale) / 2;
  const offY = (box.height - (maxY - minY) * scale) / 2;
  return monitors.map((m, i) => ({
    name: m.name,
    number: i + 1,
    color: monitorColor(i),
    left: offX + (m.x - minX) * scale + gap / 2,
    top: offY + (m.y - minY) * scale + gap / 2,
    width: Math.max(8, m.width * scale - gap),
    height: Math.max(8, m.height * scale - gap),
  }));
}

/** The tile under a point (picker-box coordinates), if any. */
export function tileAt(tiles: readonly MonitorTile[], x: number, y: number): MonitorTile | null {
  return tiles.find((t) => x >= t.left && x <= t.left + t.width && y >= t.top && y <= t.top + t.height) ?? null;
}
