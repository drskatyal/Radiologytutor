"use client";

import { useEffect, useState } from "react";
import { hasMultipleScreens } from "@/lib/screens";

/** True while the reader has two or more screens (see lib/screens.ts). */
export function useMultipleScreens(): boolean {
  const [multi, setMulti] = useState(false);
  useEffect(() => {
    // `isExtended` and the screen `change` event are Window Management API
    // (Chromium); typed loosely because lib.dom does not declare them yet.
    const scr = window.screen as Screen & { isExtended?: boolean } & Partial<Pick<EventTarget, "addEventListener" | "removeEventListener">>;
    const update = () => setMulti(hasMultipleScreens(scr));
    update();
    // Chromium fires `change` on window.screen when a monitor is plugged in or out.
    scr.addEventListener?.("change", update);
    return () => scr.removeEventListener?.("change", update);
  }, []);
  return multi;
}
