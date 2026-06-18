"use client";

// Warm the cache as soon as the case list renders: on idle, hit each case's
// prefetch manifest (cheap, server-side Orthanc metadata) so opening a case is
// instant. Low-priority and cancellable — never competes with the list render.

import { useEffect } from "react";

export default function CasesPrefetcher({ caseIds }: { caseIds: string[] }) {
  useEffect(() => {
    if (caseIds.length === 0) return;
    let cancelled = false;

    const runIdle = (cb: () => void) =>
      typeof (window as { requestIdleCallback?: unknown }).requestIdleCallback === "function"
        ? (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(cb)
        : window.setTimeout(cb, 300);

    runIdle(async () => {
      for (const id of caseIds) {
        if (cancelled) break;
        try {
          await fetch(`/api/cases/${encodeURIComponent(id)}/prefetch`, {
            // hint browsers/proxies this is background work
            priority: "low",
          } as RequestInit);
        } catch {
          /* best-effort warming */
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [caseIds]);

  return null;
}
