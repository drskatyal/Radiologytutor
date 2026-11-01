"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";

const STORAGE_KEY = "radlearn-cookie-ack";

/** Session cookie notice. No advertising cookies. */
export function CookieNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) !== "1") setVisible(true);
    } catch {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  // The positioning layer must never take clicks: as a full-width band it sat
  // over page actions on short windows (e.g. /viewer/local's "Choose a folder"
  // on a 1366×600 laptop viewport) and swallowed them. Only the card is
  // interactive, and from `sm` up it is a compact card in the corner, clear of
  // left-aligned page actions.
  return (
    <div
      role="region"
      aria-label="Cookie notice"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:justify-end"
    >
      <div className="pointer-events-auto flex w-full max-w-3xl items-center gap-3 rounded-2xl border border-subtle bg-surface p-3 shadow-md sm:w-auto sm:max-w-sm sm:p-4">
        <p className="min-w-0 flex-1 text-xs text-secondary text-pretty sm:text-sm">
          RadLearn uses a session cookie to keep you signed in. We do not run advertising cookies.
        </p>
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => {
            try {
              window.localStorage.setItem(STORAGE_KEY, "1");
            } catch {
              // Private mode can block storage. Hide the notice for this view anyway.
            }
            setVisible(false);
          }}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
