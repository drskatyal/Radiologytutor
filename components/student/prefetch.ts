"use client";

// Client-side cache warming for the student session (CLAUDE.md §4a).
//
// The manifest lists every instance, but we only fetch the slice the stack
// opens on and a short window around each finding (lib/prefetchWarm.ts).
// A prefix of the series is the wrong end of a chest CT, and firing those
// frames with Accept: application/octet-stream makes Orthanc return 400 —
// one console error per slice — while Teach is scrolling the middle.
//
// Accept matches the Cornerstone wadors loader so a 200 is the body the
// viewer will reuse. Concurrency stays small so the warmer cannot stampede
// the viewer's own retrieve. Failures are swallowed; playback never waits.

import { WADORS_FRAME_ACCEPT } from "@/lib/dicomwebProxy";
import type { PrefetchManifest } from "@/lib/prefetch";
import {
  WARM_CONCURRENCY,
  selectWarmTargets,
  wadoFrameUrl,
  type WarmTarget,
} from "@/lib/prefetchWarm";

const WADO_ROOT = "/api/dicomweb";

const warmed = new Set<string>();

function whenIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (ric) ric(fn, { timeout: 1500 });
  else setTimeout(fn, 200);
}

function warmFrame(target: WarmTarget): Promise<void> {
  const url = wadoFrameUrl(WADO_ROOT, target);
  return fetch(url, {
    priority: "low",
    cache: "force-cache",
    credentials: "same-origin",
    headers: { Accept: WADORS_FRAME_ACCEPT },
  } as RequestInit & { priority: "low" })
    .then(async (res) => {
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return;
      }
      // Consume the body so the HTTP cache actually stores the frame.
      await res.arrayBuffer();
    })
    .then(() => undefined)
    .catch(() => undefined);
}

async function warmPool(targets: WarmTarget[]): Promise<void> {
  let next = 0;
  const workers = Math.min(WARM_CONCURRENCY, targets.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < targets.length) {
        const target = targets[next];
        next += 1;
        if (target) await warmFrame(target);
      }
    })
  );
}

/**
 * Warm the DICOMweb cache for the slices Teach will show. Idempotent per
 * page load. Never blocks playback.
 */
export function warmPrefetch(manifest: PrefetchManifest): void {
  if (warmed.has(manifest.caseId) || !manifest.hasImaging) return;
  const targets = selectWarmTargets(manifest.series, manifest.focus ?? []);
  if (targets.length === 0) return;
  warmed.add(manifest.caseId);

  whenIdle(() => {
    void warmPool(targets);
  });
}
