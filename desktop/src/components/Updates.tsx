// Auto-update. Checks on launch (if allowed), asks, never installs silently:
// a viewer that changes under a radiologist mid-read is a defect
// (docs/DESKTOP_PLAN.md §4). Offline or unconfigured builds fail quietly.

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { isTauri } from "../platform";

import type { Update } from "./useUpdater";
export { useUpdater, type UpdateState } from "./useUpdater";

export function UpdatePrompt({ update, onClose }: { update: Update | null; onClose: () => void }) {
  const [progress, setProgress] = useState<{ got: number; total?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    if (!update) return;
    setError(null);
    setProgress({ got: 0 });
    try {
      let got = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") setProgress({ got: 0, total: e.data?.contentLength });
        if (e.event === "Progress") {
          got += e.data?.chunkLength ?? 0;
          setProgress((p) => ({ got, total: p?.total }));
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      setError(String(err));
      setProgress(null);
    }
  };

  return (
    <Modal
      open={!!update}
      onClose={progress ? () => undefined : onClose}
      title={update ? `FlowRad Viewer ${update.version} is available` : ""}
      description={update ? `You have ${update.currentVersion}. Installing restarts the viewer; open studies re-open from Recent.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={!!progress}>
            Later
          </Button>
          <Button onClick={install} loading={!!progress}>
            Install and restart
          </Button>
        </>
      }
    >
      {update?.body && <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface p-3 text-xs text-secondary">{update.body}</pre>}
      {progress && (
        <div className="mt-3 flex flex-col gap-1" role="status" aria-live="polite">
          <div className="text-xs text-secondary tabular-nums">
            Downloading {(progress.got / 1024 / 1024).toFixed(1)}
            {progress.total ? ` of ${(progress.total / 1024 / 1024).toFixed(1)}` : ""} MB
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-overlay">
            <div className="h-full rounded-full bg-accent" style={{ width: progress.total ? `${(100 * progress.got) / progress.total}%` : "30%" }} />
          </div>
        </div>
      )}
      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
    </Modal>
  );
}
