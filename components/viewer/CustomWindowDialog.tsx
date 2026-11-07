"use client";
// Set an exact window width / level, as RadiAnt's Ctrl+F11 dialog. Shared by
// the web viewer (Window menu, right-click menu, Ctrl/⌘+F11) and FlowRad
// Viewer (desktop), so both read and validate the values the same way
// (parseCustomWindow in the viewer core).
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { parseCustomWindow } from "@flowrad/viewer-core";

export interface CustomWindowDialogProps {
  open: boolean;
  onClose: () => void;
  /** The window on screen, to start from. */
  initial: { ww?: number; wc?: number };
  onApply: (ww: number, wc: number) => void;
  /** Unit of the values ("HU" for CT), shown beside each field. */
  unit?: string;
  /** `reading`: the free viewer's dark reading-room dialog. */
  tone?: "app" | "reading";
}

export function CustomWindowDialog({ open, onClose, initial, onApply, unit, tone }: CustomWindowDialogProps) {
  const [ww, setWw] = useState("");
  const [wc, setWc] = useState("");
  useEffect(() => {
    if (!open) return;
    setWw(initial.ww != null ? String(Math.round(initial.ww)) : "400");
    setWc(initial.wc != null ? String(Math.round(initial.wc)) : "40");
  }, [open, initial.ww, initial.wc]);
  const value = parseCustomWindow(ww, wc);
  const widthBad = ww.trim() !== "" && parseCustomWindow(ww, "0") == null;
  const levelBad = wc.trim() !== "" && parseCustomWindow("1", wc) == null;
  const apply = () => {
    if (!value) return;
    onApply(value.ww, value.wc);
    onClose();
  };
  const suffix = unit ? `, ${unit}` : "";
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set window"
      description="Type an exact width and level. Esc cancels."
      size="sm"
      tone={tone}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={!value}>
            Apply
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <Field label={`Width (WW)${suffix}`} error={widthBad ? "At least 1" : undefined}>
          {(field) => (
            <Input
              {...field}
              inputMode="decimal"
              value={ww}
              onChange={(e) => setWw(e.target.value)}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              className="tabular-nums"
            />
          )}
        </Field>
        <Field label={`Level (WL)${suffix}`} error={levelBad ? "A number" : undefined}>
          {(field) => (
            <Input
              {...field}
              inputMode="decimal"
              value={wc}
              onChange={(e) => setWc(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              className="tabular-nums"
            />
          )}
        </Field>
        {/* Enter in either field submits; the footer's Apply is the one
            assistive tech and Tab reach. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
          Apply
        </button>
      </form>
    </Modal>
  );
}
