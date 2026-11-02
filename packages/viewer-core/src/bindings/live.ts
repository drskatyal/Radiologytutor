// The live binding set for a page / app window. The app writes it once on
// load and on every change in Settings; viewports, tooltips and sheets read
// it (or subscribe), so no component threads bindings through props and a
// change applies everywhere at once.

import type { BindingOverrides } from "./map";

let current: BindingOverrides = {};
let version = 0;
const listeners = new Set<() => void>();

export function getLiveBindings(): BindingOverrides {
  return current;
}

/** Bumps on every change (cheap memo key). */
export function liveBindingsVersion(): number {
  return version;
}

export function setLiveBindings(next: BindingOverrides): void {
  if (next === current) return;
  current = next;
  version += 1;
  for (const l of [...listeners]) l();
}

export function subscribeLiveBindings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
