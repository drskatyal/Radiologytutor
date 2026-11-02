// Auto-update. Checks on launch (if allowed), asks, never installs silently:
// a viewer that changes under a radiologist mid-read is a defect
// (docs/DESKTOP_PLAN.md §4). Offline or unconfigured builds fail quietly.

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { isTauri } from "../platform";

type Update = {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
  downloadAndInstall: (onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>;
};

export type UpdateState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "current" }
  | { state: "available"; update: Update }
  | { state: "unavailable"; reason: string };

export function useUpdater(autoCheck: boolean) {
  const [status, setStatus] = useState<UpdateState>({ state: "idle" });
  const [prompt, setPrompt] = useState<Update | null>(null);

  const check = useCallback(async (interactive: boolean) => {
    if (!isTauri) {
      setStatus({ state: "unavailable", reason: "Updates apply to the desktop app only." });
      return;
    }
    setStatus({ state: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = (await check()) as Update | null;
      if (update) {
        setStatus({ state: "available", update });
        setPrompt(update);
      } else {
        setStatus({ state: "current" });
      }
    } catch (error) {
      const text = String(error);
      const reason = /pubkey|signature|REPLACED_IN_CI/i.test(text)
        ? "This build was not signed for updates (a development build)."
        : /network|dns|connect|timed out|offline|release JSON|fetch/i.test(text)
          ? "Couldn't reach the update server, or no release is published yet. The viewer works fully offline."
          : text;
      setStatus({ state: "unavailable", reason });
      if (interactive) setPrompt(null);
    }
  }, []);

  useEffect(() => {
    if (!autoCheck || !isTauri) return;
    // After first paint and first open, never in the cold-start path.
    const timer = window.setTimeout(() => void check(false), 8000);
    return () => window.clearTimeout(timer);
  }, [autoCheck, check]);

  return { status, check, prompt, dismiss: () => setPrompt(null) };
}

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
