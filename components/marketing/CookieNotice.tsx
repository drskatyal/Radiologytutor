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

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 px-4 pb-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 rounded-2xl border border-subtle bg-surface p-4 shadow-md sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-[65ch] text-sm text-secondary text-pretty">
          RadLearn uses a session cookie to keep you signed in. We do not run advertising cookies.
        </p>
        <Button
          size="sm"
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
