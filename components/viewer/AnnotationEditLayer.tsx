"use client";

// Annotation editing UI over one Cornerstone viewport, shared by the desktop
// viewer and the web viewer (logic in @flowrad/viewer-core annotationEditing):
//
//   click an annotation      select it (highlight + handles)
//   Delete / Backspace       delete the selected annotation
//   right-click (no drag)    Delete · Add/Edit label · Copy value ·
//                            Delete all on this image · Delete all in series ·
//                            Undo / Redo
//   eraser tool              click an annotation to delete it
//   double-click an arrow    inline label field next to the arrowhead
//                            (Enter saves, Esc cancels, empty is fine)
//
// Right-drag stays window/level: the menu opens only for a right click that
// did not move.

import { useCallback, useEffect, useRef, useState } from "react";
import { annotationEditing as ae } from "@flowrad/viewer-core";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { cn } from "@/components/ui/cn";

type Ctx = ae.EditingContext;
type Ann = ae.AnnotationLike;

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return (
    !!el &&
    (el.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
  );
};

export interface AnnotationEditLayerProps {
  /** Null until the viewport is enabled. */
  ctx: Ctx | null;
  /** Image ids of the series on screen (for "Delete all in series"). */
  seriesImageIds: readonly string[];
  /** Eraser tool active: a click deletes the annotation under it. */
  eraser?: boolean;
  /** Handle Ctrl+Z / Ctrl+Y here (web). The desktop routes them through its shortcut map. */
  handleUndoKeys?: boolean;
  /** Feedback after a deletion, e.g. a toast with Undo. */
  onDeleted?: (count: number, scope: "one" | "image" | "series") => void;
  onCopied?: (text: string) => void;
  /** Portal container for the menu (fullscreen element). */
  menuContainer?: HTMLElement | null;
}

export function AnnotationEditLayer({
  ctx,
  seriesImageIds,
  eraser = false,
  handleUndoKeys = false,
  onDeleted,
  onCopied,
  menuContainer,
}: AnnotationEditLayerProps) {
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: Ann | null;
  } | null>(null);
  const [edit, setEdit] = useState<
    (ae.LabelEditRequest & { value: string; openedAt: number }) | null
  >(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const openLabelRef = useRef<(a: Ann, at: { x: number; y: number }) => void>(
    () => undefined,
  );
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // Change notifications (selection, add, remove, modify, history) and redraws.
  useEffect(() => {
    if (!ctx) return;
    const off = ae.installAnnotationEditing(ctx.core, ctx.tools, bump);
    const rendered = ctx.core.Enums.Events.IMAGE_RENDERED;
    ctx.element.addEventListener(rendered, bump);
    return () => {
      off();
      ctx.element.removeEventListener(rendered, bump);
    };
  }, [ctx, bump]);

  // Inline label requests for this element.
  useEffect(() => {
    if (!ctx) return;
    return ae.registerLabelEditor(ctx.element, (req) =>
      setEdit({ ...req, value: req.current, openedAt: performance.now() }),
    );
  }, [ctx]);

  const deleteSome = useCallback(
    (list: Ann[], scope: "one" | "image" | "series") => {
      const c = ctxRef.current;
      if (!c || !list.length) return;
      const n = ae.remove(c, list);
      if (n) onDeleted?.(n, scope);
    },
    [onDeleted],
  );

  // Pointer: eraser clicks, right-click menu (no drag), deselect on empty click.
  useEffect(() => {
    if (!ctx) return;
    const el = ctx.element;
    const local = (e: PointerEvent | MouseEvent): [number, number] => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const down = (e: PointerEvent) => {
      if (e.button === 2) press.current = { x: e.clientX, y: e.clientY };
      if (e.button !== 0 || !eraser) return;
      // The eraser never draws or windows: it only deletes.
      e.preventDefault();
      e.stopImmediatePropagation();
      const hit = ae.annotationAt(ctx, local(e), 8);
      if (hit) deleteSome([hit], "one");
    };
    const up = (e: PointerEvent) => {
      if (e.button !== 2 || !press.current) return;
      const moved = Math.hypot(
        e.clientX - press.current.x,
        e.clientY - press.current.y,
      );
      press.current = null;
      if (moved > 4) return;
      const [x, y] = local(e);
      const target = ae.annotationAt(ctx, [x, y], 8);
      if (target) ae.select(ctx, target);
      setMenu({ x, y, target });
    };
    const context = (e: MouseEvent) => e.preventDefault();
    // Double-click an arrow (any tool): edit its label inline.
    const dbl = (e: MouseEvent) => {
      const hit = ae.annotationAt(ctx, local(e), 8);
      if (hit?.metadata?.toolName !== "ArrowAnnotate") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const [x, y] = local(e);
      openLabelRef.current(hit, { x, y });
    };
    el.addEventListener("dblclick", dbl, true);
    // Cornerstone listens to mouse events: with the eraser on, they stop here.
    const swallow = (e: MouseEvent) => {
      if (!eraser || e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("mousedown", swallow, true);
    window.addEventListener("pointerup", up, true);
    el.addEventListener("contextmenu", context);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("mousedown", swallow, true);
      window.removeEventListener("pointerup", up, true);
      el.removeEventListener("contextmenu", context);
      el.removeEventListener("dblclick", dbl, true);
    };
  }, [ctx, eraser, deleteSome]);

  // Keys: Delete / Backspace delete the selection on this viewport's image.
  useEffect(() => {
    if (!ctx) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || edit) return;
      const mod = e.ctrlKey || e.metaKey;
      if ((e.key === "Delete" || e.key === "Backspace") && !mod && !e.altKey) {
        const image = ae.currentImageId(ctx);
        const sel = ae
          .selected(ctx)
          .filter((a) => a.metadata?.referencedImageId === image);
        if (!sel.length) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        deleteSome(sel, "one");
        return;
      }
      if (!handleUndoKeys || !mod || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        if (ae.undo(ctx)) e.preventDefault();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        if (ae.redo(ctx)) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ctx, edit, handleUndoKeys, deleteSome]);

  if (!ctx) return null;
  const image = ae.currentImageId(ctx);
  const all = ae.allAnnotations(ctx);
  const here = ae.onImage(all, image);
  const series = ae.inSeries(all, seriesImageIds);
  const selectedHere = ae
    .selected(ctx)
    .filter((a) => a.metadata?.referencedImageId === image);
  const target = menu?.target ?? null;
  const isArrow = target?.metadata?.toolName === "ArrowAnnotate";

  const openLabel = (a: Ann, at: { x: number; y: number }) => {
    // Cornerstone may have started a drag on the first click: end it.
    ctxRef.current?.tools.cancelActiveManipulations?.(ctxRef.current.element);
    const c = ctxRef.current;
    if (!c) return;
    const tip = ae.handlesOnCanvas(c, a)[0];
    const current = ae.cleanLabel(a.data?.label);
    setEdit({
      annotation: a,
      element: c.element,
      at: tip ? { x: tip[0], y: tip[1] } : at,
      current,
      value: current,
      openedAt: performance.now(),
      done: (label) => ae.setLabel(c, a, label),
    });
  };

  openLabelRef.current = openLabel;

  return (
    <>
      {/* State for tests and assistive tech: counts only, never content. */}
      <span
        hidden
        data-testid="annotation-state"
        data-on-image={here.length}
        data-in-series={series.length}
        data-selected={selectedHere.length}
        data-labels={
          here.map((a) => ae.cleanLabel(a.data?.label)).filter(Boolean).length
        }
      />
      {/* Selection: the annotation is drawn highlighted by Cornerstone; its handles here. */}
      {selectedHere.length > 0 && (
        <svg
          className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
          aria-hidden
          data-testid="annotation-selection"
        >
          {selectedHere.flatMap((a) =>
            ae
              .handlesOnCanvas(ctx, a)
              .map(([x, y], i) => (
                <circle
                  key={`${a.annotationUID}-${i}`}
                  cx={x}
                  cy={y}
                  r={4.5}
                  className="fill-black stroke-accent-bright"
                  strokeWidth={2}
                />
              )),
          )}
        </svg>
      )}

      {edit && (
        <form
          className="absolute z-30"
          // Typing and clicking in the field must not reach the image tools.
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          // Dynamic geometry: next to the arrowhead, kept on screen.
          style={{
            left: Math.max(4, edit.at.x + 10),
            top: Math.max(4, edit.at.y - 14),
          }}
          onSubmit={(e) => {
            e.preventDefault();
            edit.done(edit.value.trim());
            setEdit(null);
          }}
        >
          <label className="sr-only" htmlFor="annotation-label">
            Arrow label
          </label>
          <input
            id="annotation-label"
            data-testid="annotation-label-input"
            autoFocus
            value={edit.value}
            placeholder="Label (optional)"
            maxLength={120}
            onChange={(e) => setEdit({ ...edit, value: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                edit.done(edit.current);
                setEdit(null);
              }
            }}
            onBlur={(e) => {
              // The double-click that opened the field can still move focus to
              // the image for a moment: keep the field until it has settled.
              if (performance.now() - edit.openedAt < 400) {
                const input = e.currentTarget;
                requestAnimationFrame(() => input.focus());
                return;
              }
              edit.done(edit.value.trim());
              setEdit(null);
            }}
            className={cn(
              "h-7 w-52 rounded-md border border-white/15 bg-black/85 px-2 text-xs text-white shadow-lg backdrop-blur",
              "placeholder:text-white/40 focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
            )}
          />
          <span className="mt-1 block text-[10px] text-white/55">
            Enter to save · Esc to cancel
          </span>
        </form>
      )}

      {menu && (
        // React events from the portalled menu bubble through this tree: keep
        // a host's "press focuses the image" handler from stealing focus (and
        // closing the menu) before the item is chosen.
        <div
          className="contents"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Menu
            label="Annotation"
            open
            onOpenChange={(open) => !open && setMenu(null)}
            side="bottom"
            align="start"
            container={menuContainer}
            trigger={
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                className="pointer-events-none absolute h-px w-px opacity-0"
                // Dynamic geometry: anchors the menu at the click.
                style={{ left: menu.x, top: menu.y }}
              />
            }
          >
            {target && (
              <>
                <MenuItem
                  label="Delete"
                  shortcut="Del"
                  onSelect={() => deleteSome([target], "one")}
                />
                {isArrow && (
                  <MenuItem
                    label={
                      ae.cleanLabel(target.data?.label)
                        ? "Edit label"
                        : "Add label"
                    }
                    onSelect={() => openLabel(target, { x: menu.x, y: menu.y })}
                  />
                )}
                <MenuItem
                  label="Copy value"
                  hint={ae.describeAnnotation(target).slice(0, 28)}
                  onSelect={() => {
                    const text = ae.describeAnnotation(target);
                    void navigator.clipboard?.writeText(text).then(
                      () => onCopied?.(text),
                      () => onCopied?.(text),
                    );
                  }}
                />
                <MenuSeparator />
              </>
            )}
            <MenuItem
              label="Delete all on this image"
              hint={String(here.length)}
              disabled={!here.length}
              onSelect={() => deleteSome(here, "image")}
            />
            <MenuItem
              label="Delete all in series"
              hint={String(series.length)}
              disabled={!series.length}
              onSelect={() => deleteSome(series, "series")}
            />
            <MenuSeparator />
            <MenuItem
              label="Undo"
              shortcut="Ctrl+Z"
              disabled={!ae.canUndo(ctx.core)}
              onSelect={() => ae.undo(ctx)}
            />
            <MenuItem
              label="Redo"
              shortcut="Ctrl+Y"
              disabled={!ae.canRedo(ctx.core)}
              onSelect={() => ae.redo(ctx)}
            />
          </Menu>
        </div>
      )}
    </>
  );
}
