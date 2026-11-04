"use client";

// The web viewer's plugin host (packages/viewer-core/src/plugins.ts), wired to
// the live viewer. Does nothing at all when no plugins are configured, which
// is the default: no host, no fetch, no listeners.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPluginHost, type PluginEntry, type PluginHost, type ViewerCommand, type ViewerCommandResult, type ViewerStateSnapshot } from "@flowrad/viewer-core";
import type { PluginSource } from "@/lib/pluginConfig";
import { loadPlugin } from "./loader";

export interface PluginHostBinding {
  host: PluginHost | null;
  entries: PluginEntry[];
  loading: boolean;
}

export function usePluginHost({
  sources,
  run,
  overlayRoot,
  state,
}: {
  sources: readonly PluginSource[];
  /** Runs a validated command in the viewer (CornerstoneControls.runCommand). */
  run: (command: ViewerCommand) => Promise<ViewerCommandResult>;
  overlayRoot: () => HTMLElement | null;
  state: ViewerStateSnapshot;
}): PluginHostBinding {
  const [entries, setEntries] = useState<PluginEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const hostRef = useRef<PluginHost | null>(null);
  const runRef = useRef(run);
  runRef.current = run;
  const overlayRef = useRef(overlayRoot);
  overlayRef.current = overlayRoot;
  const key = useMemo(() => sources.map((s) => `${s.id}@${s.sha256}`).join(","), [sources]);

  useEffect(() => {
    if (!sources.length) return;
    const host = createPluginHost({
      run: (c) => runRef.current(c),
      overlayRoot: () => overlayRef.current(),
      createElement: (tag) => document.createElement(tag),
      onChange: () => setEntries([...host.entries()]),
      log: (m) => console.warn(`[flowrad plugins] ${m}`),
    });
    hostRef.current = host;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      for (const source of sources) {
        try {
          const plugin = await loadPlugin(source);
          if (cancelled) return;
          await host.register(plugin);
        } catch (err) {
          if (cancelled) return;
          host.registerFailure(source.id, source.id, err instanceof Error ? err.message : "Could not load the plugin.");
        }
      }
      if (!cancelled) setLoading(false);
    })();

    // Plugin hotkeys are Alt+Shift+<key> only; everything else stays the viewer's.
    const down = (e: KeyboardEvent) => {
      if (host.handleKeyDown(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (host.handleKeyUp(e)) e.preventDefault();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      host.dispose();
      hostRef.current = null;
      setEntries([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    hostRef.current?.setState(state);
  }, [state]);

  return { host: hostRef.current, entries, loading };
}
