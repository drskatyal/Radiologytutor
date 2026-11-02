// Imperative handle each on-screen viewport registers, so the toolbar and the
// keyboard act on "the active viewport" without prop-drilling Cornerstone.

export interface ViewportReadout {
  index: number;
  count: number;
  ww?: number;
  wc?: number;
  zoom?: number;
  rotation?: number;
}

export interface ViewportHandle {
  viewportId: string;
  element: HTMLDivElement;
  seriesUid: string | null;
  setVoi(ww: number, wc: number): void;
  resetVoi(): void;
  invert(): void;
  zoomTo(scale: number | "fit"): void;
  zoomBy(factor: number): void;
  pan(dx: number, dy: number): void;
  rotate(degrees: number): void;
  flip(axis: "h" | "v"): void;
  reset(): void;
  step(delta: number): void;
  goTo(where: "first" | "last" | number): void;
  toggleCine(): void;
  setCineFps(fps: number): void;
  cine(): { playing: boolean; fps: number };
  readout(): ViewportReadout | null;
  /** Show image `i` and resolve once it has been drawn (export, video). */
  renderFrame(i: number): Promise<void>;
}

const handles = new Map<string, ViewportHandle>();
const listeners = new Set<() => void>();

export function registerHandle(cellKey: string, handle: ViewportHandle): () => void {
  handles.set(cellKey, handle);
  listeners.forEach((l) => l());
  return () => {
    if (handles.get(cellKey) === handle) handles.delete(cellKey);
    listeners.forEach((l) => l());
  };
}

export function getHandle(cellKey: string): ViewportHandle | undefined {
  return handles.get(cellKey);
}

export function allHandles(): ViewportHandle[] {
  return [...handles.values()];
}

export function onHandlesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
