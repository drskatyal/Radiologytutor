"use client";

// Open / collapsed state of the series panel, remembered per device
// (viewer-core seriesPanel.ts). Shared by the web viewer and the desktop app.

import { useCallback, useEffect, useState } from "react";
import { readSeriesPanelCollapsed, writeSeriesPanelCollapsed } from "@flowrad/viewer-core";

export function useSeriesPanel(): { collapsed: boolean; toggle: () => void; setCollapsed: (v: boolean) => void } {
  // Open on the server render; the stored choice applies on mount.
  const [collapsed, setState] = useState(false);
  useEffect(() => setState(readSeriesPanelCollapsed()), []);
  const setCollapsed = useCallback((v: boolean) => {
    setState(v);
    writeSeriesPanelCollapsed(v);
  }, []);
  const toggle = useCallback(() => {
    setState((v) => {
      writeSeriesPanelCollapsed(!v);
      return !v;
    });
  }, []);
  return { collapsed, toggle, setCollapsed };
}
