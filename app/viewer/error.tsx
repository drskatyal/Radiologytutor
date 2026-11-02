"use client";

// Last line of defence for /viewer: anything that throws while rendering ends
// here, never as a raw message on the black stage. Code that failed to load
// (a new build replaced this tab's, or a dropped request) reloads once onto
// the live build (lib/chunkRecovery.ts guards against a loop).

import { useEffect, useState } from "react";
import { Button, Spinner } from "@/components/ui";
import { isChunkLoadError, reloadForChunkError } from "@/lib/chunkRecovery";

export default function ViewerError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const chunk = isChunkLoadError(error);
  const [reloading, setReloading] = useState(chunk);

  useEffect(() => {
    if (!chunk) return;
    const timer = window.setTimeout(() => {
      if (!reloadForChunkError()) setReloading(false);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [chunk]);

  return (
    <div className="flex h-dvh min-h-0 items-center justify-center bg-imaging p-6 text-white">
      {reloading ? (
        <div role="status" aria-live="polite" data-testid="viewer-updating" className="flex flex-col items-center gap-3 text-center">
          <Spinner size="md" label="Updating viewer" />
          <p className="text-sm font-medium">Updating viewer, reloading…</p>
          <p className="text-xs text-white/60">Your files stay on this computer.</p>
        </div>
      ) : (
        <div role="alert" data-testid="viewer-recovery" className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-base font-semibold">{chunk ? "The viewer could not load" : "Something went wrong in the viewer"}</p>
          <p className="text-sm text-white/70">
            {chunk ? "Check your connection, then reload the page." : "Try again. If it keeps happening, reload the page."} Your files
            stayed on this computer.
          </p>
          <div className="flex gap-2">
            {!chunk && (
              <Button variant="imaging" onClick={reset}>
                Try again
              </Button>
            )}
            <Button variant="imaging" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
