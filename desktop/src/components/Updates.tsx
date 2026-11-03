// "Update ready — Restart" (docs/UPDATES.md). A non-blocking banner in the
// corner, never a modal: the reader keeps working, and nothing installs until
// they choose Restart now. A viewer that changes under a radiologist mid-read
// is a defect (docs/DESKTOP_PLAN.md §4). Lazily loaded: not in the startup bundle.

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { invoke } from "../platform";

import type { Update } from "./useUpdater";
export { useUpdater, type UpdateState } from "./useUpdater";

export function UpdatePrompt({ update, onClose }: { update: Update | null; onClose: () => void }) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!update) return null;

  const restart = async () => {
    setError(null);
    setRestarting(true);
    try {
      await invoke("update_apply");
    } catch (err) {
      setRestarting(false);
      setError(`The update couldn't be installed (${String(err)}). Your current version keeps working; it will try again later.`);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`FlowRad Viewer ${update.version} is ready to install`}
      className="fixed bottom-4 right-4 z-50 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border border-subtle bg-elevated p-4 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-primary">Update ready: FlowRad Viewer {update.version}</p>
          <p className="mt-0.5 text-xs text-muted">
            You have {update.currentVersion}. It's downloaded and verified; restarting installs it. Open studies re-open from Recent.
          </p>
          {update.notes && <p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-secondary">{update.notes}</p>}
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        </div>
        <IconButton aria-label="Dismiss update notice" size="sm" variant="ghost" onClick={onClose} disabled={restarting}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </IconButton>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={restarting}>
          Later
        </Button>
        <Button size="sm" onClick={() => void restart()} loading={restarting}>
          Restart now
        </Button>
      </div>
    </div>
  );
}
