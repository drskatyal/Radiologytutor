"use client";

// On idle, fetch each case's prefetch manifest (series order only — no frame
// bodies) in batches of 4. Pixel prefetch of the active series happens in the
// viewer after the first frame, not from this list warmer.

import { useEffect } from "react";

const BATCH = 4;

export default function CasesPrefetcher({ caseIds }: { caseIds: string[] }) {
  useEffect(() => {
    if (caseIds.length === 0) return;
    let cancelled = false;

    const runIdle = (cb: () => void) =>
      typeof (window as { requestIdleCallback?: unknown }).requestIdleCallback ===
      "function"
        ? (
            window as unknown as {
              requestIdleCallback: (cb: () => void) => number;
            }
          ).requestIdleCallback(cb)
        : window.setTimeout(cb, 300);

    runIdle(async () => {
      for (let i = 0; i < caseIds.length; i += BATCH) {
        if (cancelled) break;
        const slice = caseIds.slice(i, i + BATCH);
        await Promise.allSettled(
          slice.map((id) =>
            fetch(`/api/cases/${encodeURIComponent(id)}/prefetch`, {
              priority: "low",
            } as RequestInit).catch(() => null)
          )
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [caseIds]);

  return null;
}
