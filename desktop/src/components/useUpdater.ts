// The update check, without the dialog: App needs it at startup, and the
// dialog (Modal → framer-motion) would put ~40% more JS in front of first paint.
import { useCallback, useEffect, useState } from "react";
import { isTauri } from "../platform";

export type Update = {
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
