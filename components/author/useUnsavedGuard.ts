"use client";

// Guards against losing in-progress edits. While `dirty` is true we attach a
// `beforeunload` handler so closing the tab / hard-navigating prompts the
// native "leave site?" dialog. In-app navigation (switching findings, leaving
// the case) is guarded explicitly at the call site via `confirmDiscard`.

import { useCallback, useEffect } from "react";

export function useUnsavedGuard(dirty: boolean): {
  /** Returns true if it's safe to proceed (no edits, or the user confirmed). */
  confirmDiscard: () => boolean;
} {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require returnValue to be set.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const confirmDiscard = useCallback(() => {
    if (!dirty) return true;
    return window.confirm(
      "You have unsaved changes to this finding. Discard them?"
    );
  }, [dirty]);

  return { confirmDiscard };
}
