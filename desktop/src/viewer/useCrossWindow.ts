// Linked scroll, window/level, zoom and reference lines between viewer
// windows (other monitors / popped-out windows). The active viewport tells the
// others where it is after each render; the others apply it to their visible
// stacks when that link is on. Sends are coalesced to one per frame and only
// when a value changed, so applying a remote value never echoes back.

import { useEffect, useRef, useState } from "react";
import type { WindowSyncMessage } from "@flowrad/viewer-core";
import type { RemotePlane } from "@/components/viewer/RemoteReferenceLines";
import { onWindowMessage, postToWindows, windowId } from "../multiWindow";
import { applyRemoteSlice, getEngine, slicePosition, viewportCorners, type Engine } from "./engine";

export interface WindowLinks {
  scroll: boolean;
  voi: boolean;
  zoom: boolean;
  referenceLines: boolean;
}

interface Options {
  /** Off until a study is open. */
  enabled: boolean;
  /** Visible stack viewports (Cornerstone ids). */
  viewportIds: readonly string[];
  /** The active viewport and its element (what this window sends). */
  active: { viewportId: string; element: HTMLElement } | null;
  links: WindowLinks;
  /** Another window toggled a link: apply it here (no rebroadcast). */
  onLinks: (links: WindowLinks) => void;
  /** This window's monitor index (colours its reference lines elsewhere). */
  monitorIndex?: number;
}

export function useCrossWindow({ enabled, viewportIds, active, links, onLinks, monitorIndex }: Options): RemotePlane[] {
  const [planes, setPlanes] = useState<Record<string, RemotePlane>>({});
  const engineRef = useRef<Engine | null>(null);
  const live = useRef({ viewportIds, links, onLinks, monitorIndex });
  live.current = { viewportIds, links, onLinks, monitorIndex };
  /** What this window last sent / last applied, per kind: never re-send an equal value. */
  const last = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void getEngine().then((e) => alive && (engineRef.current = e));
    return () => {
      alive = false;
    };
  }, [enabled]);

  // Incoming.
  useEffect(() => {
    if (!enabled) return;
    return onWindowMessage((m: WindowSyncMessage) => {
      const engine = engineRef.current;
      const { viewportIds: ids, links: on } = live.current;
      switch (m.kind) {
        case "links":
          live.current.onLinks({ scroll: m.scroll, voi: m.voi, zoom: m.zoom, referenceLines: m.referenceLines });
          return;
        case "plane":
          if (on.referenceLines) setPlanes((p) => ({ ...p, [m.from]: { from: m.from, frame: m.frame, corners: m.corners, monitorIndex: m.monitorIndex } }));
          return;
        case "closed":
          setPlanes((p) => {
            const { [m.from]: _gone, ...rest } = p;
            return rest;
          });
          return;
        case "slice":
          if (engine && on.scroll) {
            last.current.slice = key(m.frame, Math.round(m.z * 10));
            applyRemoteSlice(engine, ids, m);
          }
          return;
        case "voi":
          if (engine && on.voi) {
            last.current.voi = key(Math.round(m.ww), Math.round(m.wc));
            for (const id of ids) {
              const vp = engine.renderingEngine.getViewport(id) as { setProperties?(p: unknown): void; render?(): void } | undefined;
              vp?.setProperties?.({ voiRange: { lower: m.wc - m.ww / 2, upper: m.wc + m.ww / 2 } });
              vp?.render?.();
            }
          }
          return;
        case "zoom":
          if (engine && on.zoom) {
            last.current.zoom = key(Math.round(m.zoom * 1000));
            for (const id of ids) {
              const vp = engine.renderingEngine.getViewport(id) as { setZoom?(z: number): void; render?(): void } | undefined;
              vp?.setZoom?.(m.zoom);
              vp?.render?.();
            }
          }
          return;
        default:
          return;
      }
    });
  }, [enabled]);

  // Drop reference lines when the link goes off.
  useEffect(() => {
    if (!links.referenceLines) setPlanes({});
  }, [links.referenceLines]);

  // Outgoing: after each render of the active viewport, one frame at most.
  useEffect(() => {
    if (!enabled || !active) return;
    let frame = 0;
    const send = () => {
      frame = 0;
      const engine = engineRef.current;
      if (!engine) return;
      const { links: on, monitorIndex: mi } = live.current;
      const id = active.viewportId;
      const vp = engine.renderingEngine.getViewport(id) as
        | { getProperties?(): { voiRange?: { lower: number; upper: number } }; getZoom?(): number }
        | undefined;
      if (!vp) return;
      if (on.scroll) {
        const at = slicePosition(engine, id);
        const k = at && key(at.frame, Math.round(at.z * 10));
        if (at && k !== last.current.slice) {
          last.current.slice = k!;
          postToWindows({ kind: "slice", from: windowId, ...at });
        }
      }
      if (on.voi) {
        const r = vp.getProperties?.().voiRange;
        if (r) {
          const ww = r.upper - r.lower;
          const wc = (r.upper + r.lower) / 2;
          const k = key(Math.round(ww), Math.round(wc));
          if (k !== last.current.voi) {
            last.current.voi = k;
            postToWindows({ kind: "voi", from: windowId, ww, wc });
          }
        }
      }
      if (on.zoom) {
        const z = vp.getZoom?.();
        const k = z != null ? key(Math.round(z * 1000)) : "";
        if (z != null && k !== last.current.zoom) {
          last.current.zoom = k;
          postToWindows({ kind: "zoom", from: windowId, zoom: z });
        }
      }
      if (on.referenceLines) {
        const plane = viewportCorners(engine, id);
        const k = plane && key(plane.frame, ...plane.corners.flat().map((v) => Math.round(v)));
        if (plane && k !== last.current.plane) {
          last.current.plane = k!;
          postToWindows({ kind: "plane", from: windowId, ...plane, monitorIndex: mi });
        }
      }
    };
    const onRender = () => {
      if (!frame) frame = requestAnimationFrame(send);
    };
    let ev = "CORNERSTONE_IMAGE_RENDERED";
    void getEngine().then((e) => {
      ev = e.core.Enums.Events.IMAGE_RENDERED;
      active.element.addEventListener(ev, onRender);
      onRender();
    });
    return () => {
      active.element.removeEventListener(ev, onRender);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, active?.viewportId, active?.element]);

  return Object.values(planes);
}

const key = (...parts: (string | number)[]) => parts.join("|");
