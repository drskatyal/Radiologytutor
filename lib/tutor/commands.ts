import type { ViewerSnapshot } from '../journal/types';
import type { ReplayShape } from '../replay/types';
export class TutorCommandError extends Error {
  readonly status = 422;
  constructor(message = 'This tutor command has no current approved image target.') { super(message); this.name = 'TutorCommandError'; }
}
export type TutorCommand =
  | { type: 'show_finding'; findingId: string }
  | { type: 'show_anchor'; anchorId: string }
  | { type: 'highlight'; annotationId: string }
  | { type: 'scroll_to'; sopUID: string; frame: number; seriesUID: string }
  | { type: 'set_window'; ww: number; wc: number }
  | { type: 'zoom'; zoom: number }
  | { type: 'set_invert'; value: boolean }
  | { type: 'set_series'; seriesUID: string }
  | { type: 'next_in_tour' | 'prev_in_tour' | 'hold' | 'clear_overlay' };
export interface TutorStep { command: TutorCommand; findingId: string; anchorId: string; snapshot: ViewerSnapshot; shapes?: ReplayShape[] }
const presets: Record<string, [number, number]> = { lung: [1500, -600], soft_tissue: [400, 40], bone: [2000, 300], brain: [80, 40] };
const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TutorCommandError('Invalid tutor command.'); return v as Record<string, unknown>; };
const keys = (a: Record<string, unknown>, allowed: string[]) => { if (Object.keys(a).some(k => !['type', ...allowed].includes(k))) throw new TutorCommandError('Free coordinates and unknown command fields are not allowed.'); };
const id = (v: unknown): string => { if (typeof v !== 'string' || !v || v.length > 1024) throw new TutorCommandError('A named approved target is required.'); return v; };
const range = (v: unknown, min: number, max: number): number => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new TutorCommandError('Viewer value is outside the allowed range.'); return v; };
/** Strict schema at both transport boundaries. No arbitrary model coordinates. */
export function parseTutorCommand(raw: unknown): TutorCommand {
  const a = record(raw);
  switch (a.type) {
    case 'show_finding': keys(a, ['findingId']); return { type: a.type, findingId: id(a.findingId) };
    case 'show_anchor': keys(a, ['anchorId']); return { type: a.type, anchorId: id(a.anchorId) };
    case 'highlight': keys(a, ['annotationId']); return { type: a.type, annotationId: id(a.annotationId) };
    case 'scroll_to': keys(a, ['sopUID', 'frame', 'seriesUID']); if (!Number.isInteger(a.frame)) throw new TutorCommandError('An exact frame is required.'); return { type: a.type, sopUID: id(a.sopUID), seriesUID: id(a.seriesUID), frame: range(a.frame, 1, 1000000) };
    case 'set_window': {
      keys(a, ['ww', 'wc', 'preset']);
      if (a.preset !== undefined) { if (a.ww !== undefined || a.wc !== undefined || typeof a.preset !== 'string' || !presets[a.preset]) throw new TutorCommandError('Unknown window preset.'); const [ww, wc] = presets[a.preset]; return { type: a.type, ww, wc }; }
      return { type: a.type, ww: range(a.ww, 1, 10000), wc: range(a.wc, -10000, 10000) };
    }
    case 'zoom': keys(a, ['zoom']); return { type: a.type, zoom: range(a.zoom, .1, 10) };
    case 'set_invert': keys(a, ['value']); if (typeof a.value !== 'boolean') throw new TutorCommandError(); return { type: a.type, value: a.value };
    case 'set_series': keys(a, ['seriesUID']); return { type: a.type, seriesUID: id(a.seriesUID) };
    case 'next_in_tour': case 'prev_in_tour': case 'hold': case 'clear_overlay': keys(a, []); return { type: a.type };
    default: throw new TutorCommandError('Unsupported tutor command.');
  }
}
/** Compatibility with the existing P0-4 validated planner. Coordinates are never copied. */
export function plannerCommand(raw: unknown): TutorCommand {
  const a = record(raw);
  if (['x_pct', 'y_pct', 'x2_pct', 'y2_pct', 'panX', 'panY', 'coordinates'].some(k => a[k] !== undefined)) throw new TutorCommandError('Model coordinates are not allowed.');
  if (['point_to', 'scroll_to'].includes(String(a.type)) && a.anchorId) return parseTutorCommand({ type: 'show_anchor', anchorId: a.anchorId });
  if (a.type === 'draw_annotation') return parseTutorCommand({ type: 'highlight', annotationId: a.annotationId });
  if (['jump_to_key_view'].includes(String(a.type))) return parseTutorCommand({ type: 'show_finding', findingId: a.findingId });
  if (a.type === 'set_window' && 'windowWidth' in a) return parseTutorCommand({ type: 'set_window', ww: a.windowWidth, wc: a.windowCenter });
  if (['zoom_to', 'set_zoom'].includes(String(a.type))) return parseTutorCommand({ type: 'zoom', zoom: a.zoom });
  if (a.type === 'set_series' && 'seriesInstanceUID' in a) {
    if (a.anchorId) return parseTutorCommand({ type: 'show_anchor', anchorId: a.anchorId });
    if (a.sliceIndex !== undefined || a.ww !== undefined || a.wc !== undefined) throw new TutorCommandError('Use a named approved anchor and a separate window command.');
    return parseTutorCommand({ type: 'set_series', seriesUID: a.seriesInstanceUID });
  }
  return parseTutorCommand(a);
}
