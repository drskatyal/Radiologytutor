// "Remember studies I open" for the free viewer (the desktop's "Local study
// database" setting): one live value per page, kept in this browser, that the
// landing's list, the open path and Help › Customise all follow. Turning it
// off clears what was kept (lib/recentStudyStore: entries, handles, salt).

import { useSyncExternalStore } from "react";
import { readRecentStudiesEnabled, writeRecentStudiesEnabled } from "@flowrad/viewer-core/recentStudies";
import { clearRecentStudies } from "@/lib/recentStudyStore";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

let current: boolean | null = null;
const listeners = new Set<() => void>();

export function getRecentStudiesEnabled(): boolean {
  if (current == null) current = readRecentStudiesEnabled(storage());
  return current;
}

/** On / off now, remembered; off also forgets every recent study. */
export function setRecentStudiesEnabled(on: boolean): Promise<void> {
  current = on;
  writeRecentStudiesEnabled(on, storage());
  for (const listener of listeners) listener();
  return on ? Promise.resolve() : clearRecentStudies();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The live setting (on during server render: the landing renders nothing either way until it lists). */
export function useRecentStudiesEnabled(): boolean {
  return useSyncExternalStore(subscribe, getRecentStudiesEnabled, () => true);
}
