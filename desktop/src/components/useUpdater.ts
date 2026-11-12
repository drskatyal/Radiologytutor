// Self-update, from the front end's side (docs/UPDATES.md). Kept out of the
// startup bundle's critical path: nothing runs until the window has painted,
// and the prompt is a small, lazily loaded banner.
//
// * Automatic check ~10 s after first paint, then every 4 h (Settings can turn
//   it off), never while a study is opening. Rust downloads and verifies the
//   update in the background and parks it on disk.
// * "Update ready — Restart now / Later": a non-blocking banner, never a modal,
//   never an install without the user's click.
// * A failed check or a bad signature is silent (logged locally by Rust) and
//   retried on the next cycle. "Check now" says what happened.
// * ~20 s after first paint the running version reports "healthy", which ends
//   its post-update probation (a version that never gets there is rolled back
//   on a later launch).
// * The signed remote config / licence refresh rides along with each check.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "../platform";
import { HEALTHY_AFTER_MS, describeCheckError, nextCheckInMs } from "../updateSchedule";
import { loadEntitlement, refreshEntitlement } from "../licence";

export type Update = {
  version: string;
  currentVersion: string;
  notes?: string | null;
};

export type UpdateState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "current" }
  /** Downloaded, verified and ready to install on restart. */
  | { state: "available"; update: Update }
  | { state: "unavailable"; reason: string };

function afterFirstPaint(cb: () => void): () => void {
  let cancelled = false;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: FrameRequestCallback) => setTimeout(() => f(0), 16) as unknown as number;
  raf(() => raf(() => !cancelled && cb()));
  return () => {
    cancelled = true;
  };
}

export function useUpdater(autoCheck: boolean, busy = false) {
  const [status, setStatus] = useState<UpdateState>({ state: "idle" });
  const [prompt, setPrompt] = useState<Update | null>(null);
  const [paintedAt, setPaintedAt] = useState<number | null>(null);
  const lastCheck = useRef<number | null>(null);
  const running = useRef(false);
  const dismissed = useRef<string | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [tick, setTick] = useState(0);

  const check = useCallback(async (interactive: boolean) => {
    if (!isTauri) {
      setStatus({ state: "unavailable", reason: "Updates apply to the desktop app only." });
      return;
    }
    if (running.current) return;
    running.current = true;
    if (interactive) setStatus({ state: "checking" });
    try {
      void refreshEntitlement();
      const update = await invoke<Update | null>("update_check");
      if (update) {
        setStatus({ state: "available", update });
        if (interactive || dismissed.current !== update.version) setPrompt(update);
      } else {
        setStatus({ state: "current" });
      }
    } catch (error) {
      // Silent unless asked: Rust has logged it; the next cycle retries.
      if (interactive) setStatus({ state: "unavailable", reason: describeCheckError(error) });
      else setStatus((s) => (s.state === "checking" ? { state: "idle" } : s));
    } finally {
      lastCheck.current = Date.now();
      running.current = false;
      setTick((t) => t + 1);
    }
  }, []);

  // First paint: start the clocks; report healthy a little later.
  useEffect(() => {
    if (!isTauri) return;
    let healthy: number | undefined;
    const cancel = afterFirstPaint(() => {
      setPaintedAt(Date.now());
      void loadEntitlement();
      healthy = window.setTimeout(() => void invoke("update_mark_healthy").catch(() => undefined), HEALTHY_AFTER_MS);
    });
    return () => {
      cancel();
      if (healthy) window.clearTimeout(healthy);
    };
  }, []);

  // The automatic schedule.
  useEffect(() => {
    if (!isTauri || paintedAt === null) return;
    const wait = nextCheckInMs({
      enabled: autoCheck,
      busy,
      sinceFirstPaintMs: Date.now() - paintedAt,
      sinceLastCheckMs: lastCheck.current === null ? null : Date.now() - lastCheck.current,
    });
    if (wait === null) return;
    const timer = window.setTimeout(() => {
      if (busyRef.current) setTick((t) => t + 1);
      else void check(false);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [autoCheck, busy, paintedAt, tick, check]);

  const apply = useCallback(async () => {
    await invoke("update_apply");
  }, []);

  const dismiss = useCallback(() => {
    setPrompt((p) => {
      if (p) dismissed.current = p.version;
      return null;
    });
  }, []);

  return { status, check, prompt, apply, dismiss };
}
