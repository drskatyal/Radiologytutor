"use client";

// Warm the cache as soon as the case list renders: on idle, hit each case's
// prefetch manifest in parallel batches of 4 (Promise.allSettled) so opening a
// case is instant and multi-series work stays off the list render. Finding-first
// warming of actual frames happens in components/student/prefetch.ts (≤30s).

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
