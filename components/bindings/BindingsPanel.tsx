"use client";

// Settings › Mouse & Keyboard — one panel for the desktop app and the web
// viewer (docs/BINDINGS_DESIGN.md). Lazy-loaded by both (dynamic import on
// open), so it costs nothing until the reader opens it.
//
// Mouse: one row per button × click / drag and per wheel gesture, each with a
// command picker; "Add a mouse button" captures ANY button the OS reports
// (gaming / programmable mice: buttons 6, 7, 8…, tilt). Keyboard: a searchable
// list of every command; "Change" listens for the next key, button or tilt
// ("Press the key or button you want to bind"), shows what it received, and
// asks before taking an input from another command ("R is already Rotate 90°
// clockwise — swap or cancel?").

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Download, Keyboard, Mouse, Plus, RotateCcw, Search, Upload } from "lucide-react";
import {
  BindingError,
  BindingsFileError,
  InputCapture,
  acceptsInput,
  assignInput,
  clearInput,
  effectiveInputs,
  exportBindings,
  findConflict,
  inputIndex,
  inputKind,
  inputLabel,
  isCustomised,
  isMac,
  normalizeSpec,
  parseBindings,
  resetCommand,
  type BindingCommand,
  type BindingOverrides,
  type BindingSurface,
  type BindingTable,
  type CaptureEvent,
} from "@flowrad/viewer-core/bindings";
import { Button } from "@/components/ui/Button";
import { FilePickerButton } from "@/components/ui/FilePickerButton";
import { IconButton } from "@/components/ui/IconButton";
import { Input, Select } from "@/components/ui/Input";
import { Kbd } from "@/components/ui/Kbd";
import { Tabs } from "@/components/ui/Tabs";
import { cn } from "@/components/ui/cn";

export interface BindingsPanelProps {
  /** The surface's commands (its keyboard preset + the shared mouse rows). */
  table: BindingTable;
  overrides: BindingOverrides;
  onChange: (next: Record<string, string[]>) => void;
  surface: BindingSurface;
  /** Inputs the surface binds outside the table (ranges such as "1 … 9"). */
  reserved?: (spec: string) => BindingCommand | null;
  /** Save an export (desktop: a save dialog). Default: a browser download. */
  saveExport?: (text: string, fileName: string) => Promise<void> | void;
  /** Where the reader's bindings are kept, for the footer ("this computer", "your account"). */
  storedWhere?: string;
  /**
   * Commands not offered right now (desktop: "next monitor" on a single
   * display). Left out of the rows and choices only: their bindings are kept
   * and still count for conflicts.
   */
  hidden?: ReadonlySet<string>;
  mac?: boolean;
}

type Tab = "mouse" | "keyboard";

interface Pending {
  /** Command being bound (keyboard rows) or null (mouse "add a button"). */
  commandId: string | null;
  mode: "replace" | "add";
  spec?: string;
  conflict?: BindingCommand | null;
  error?: string;
}

const MOUSE_BUTTON_ROWS = [1, 2, 3, 4];
const WHEEL_ROWS = ["Wheel", "Mod+Wheel", "Shift+Wheel", "Alt+Wheel"];
const TILT_ROWS = ["WheelLeft", "WheelRight"];

export function BindingsPanel({ table, overrides, onChange, surface, reserved, saveExport, storedWhere, hidden, mac = isMac() }: BindingsPanelProps) {
  const [tab, setTab] = useState<Tab>("mouse");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "success" | "warning" } | null>(null);
  const fileId = useId();
  const byId = useMemo(() => new Map(table.map((c) => [c.id, c])), [table]);
  const eff = useMemo(() => effectiveInputs(table, overrides), [table, overrides]);
  const index = useMemo(() => inputIndex(table, overrides), [table, overrides]);
  const customised = Object.keys(overrides).length;

  const apply = useCallback(
    (next: Record<string, string[]>, text?: string) => {
      onChange(next);
      if (text) setNotice({ text, tone: "success" });
    },
    [onChange]
  );

  // ── capture ──
  const captureRef = useRef<InputCapture | null>(null);
  const received = useCallback(
    (spec: string) => {
      setPending((p) => {
        if (!p || p.spec) return p;
        const cmd = p.commandId ? byId.get(p.commandId) : null;
        if (cmd && !acceptsInput(cmd.kind, spec)) {
          const kind = inputKind(spec);
          const why =
            kind === "click" && /Mouse2$/.test(spec)
              ? "Right click opens the image menu — choose another button."
              : kind === "click" && /Mouse0$/.test(spec)
                ? "The left button is the selected tool — press another button or a key."
                : `${inputLabel(spec, mac)} can't run “${cmd.label}”.`;
          return { ...p, error: why };
        }
        const conflict = p.commandId ? findConflict(table, overrides, p.commandId, spec, reserved) : null;
        return { ...p, spec: normalizeSpec(spec), conflict, error: undefined };
      });
    },
    [byId, mac, overrides, reserved, table]
  );

  useEffect(() => {
    if (!pending || pending.spec || pending.commandId === null) return;
    // Keyboard-row capture: keys anywhere; buttons and tilt on the capture pad.
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setPending(null);
        return;
      }
      const spec = captureRef.current?.feed({ type: "keydown", key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey });
      if (spec) received(spec);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, received]);

  const startCapture = (commandId: string | null, mode: Pending["mode"]) => {
    captureRef.current = new InputCapture(mac);
    setNotice(null);
    setPending({ commandId, mode });
  };

  const feedPad = (e: CaptureEvent) => {
    const spec = captureRef.current?.feed(e);
    if (spec) received(spec);
  };

  const confirm = (swap: boolean) => {
    if (!pending?.spec) return;
    const spec = pending.spec;
    try {
      if (pending.commandId) {
        const cmd = byId.get(pending.commandId)!;
        const next = assignInput(table, overrides, pending.commandId, spec, { swap, mode: pending.mode, reserved });
        apply(next, `${inputLabel(spec, mac)} → ${cmd.label}`);
      }
    } catch (err) {
      setNotice({ text: err instanceof BindingError ? err.message : "That binding couldn't be saved.", tone: "warning" });
    }
    setPending(null);
  };

  // ── mouse rows: input → command ──
  const extraButtons = useMemo(() => {
    const seen = new Set<string>();
    for (const specs of eff.values())
      for (const s of specs) {
        const k = inputKind(s);
        if (k === "click" || k === "drag") seen.add(s);
      }
    return [...seen];
  }, [eff]);

  const mouseRows = useMemo(() => {
    const rows: { spec: string; kind: "drag" | "click" | "wheel" | "tilt"; fixed?: string }[] = [];
    const add = (spec: string, kind: (typeof rows)[number]["kind"], fixed?: string) => {
      const n = normalizeSpec(spec);
      if (!rows.some((r) => r.spec === n)) rows.push({ spec: n, kind, fixed });
    };
    add("Mouse0Drag", "drag", "The selected tool");
    add("Mouse2", "click", "Image menu");
    for (const b of MOUSE_BUTTON_ROWS) {
      add(`Mouse${b}Drag`, "drag");
      if (b !== 2) add(`Mouse${b}`, "click");
    }
    for (const s of extraButtons) add(s, inputKind(s) === "drag" ? "drag" : "click");
    for (const s of WHEEL_ROWS) add(s, "wheel");
    for (const s of TILT_ROWS) add(s, "tilt");
    return rows;
  }, [extraButtons]);

  const setMouseRow = (spec: string, commandId: string) => {
    const holder = index.get(spec);
    try {
      if (!commandId) {
        if (holder) apply(clearInput(table, overrides, holder, spec), `${inputLabel(spec, mac)} unbound`);
        return;
      }
      const cmd = byId.get(commandId)!;
      apply(assignInput(table, overrides, commandId, spec, { swap: false, mode: "add", reserved: undefined }), `${inputLabel(spec, mac)} → ${cmd.label}`);
    } catch (err) {
      if (err instanceof BindingError && holder) {
        // The row IS the input: move it from its holder to the chosen command.
        const freed = clearInput(table, overrides, holder, spec);
        apply(assignInput(table, freed, commandId, spec, { mode: "add" }), `${inputLabel(spec, mac)} → ${byId.get(commandId)!.label}`);
      } else setNotice({ text: err instanceof Error ? err.message : "That binding couldn't be saved.", tone: "warning" });
    }
  };

  /** Commands a mouse input can take (a hidden one only while it already holds it). */
  const optionsFor = (kind: "drag" | "click" | "wheel" | "tilt", holder?: string) =>
    table.filter((c) => (!hidden?.has(c.id) || c.id === holder) && (kind === "drag" ? c.kind === "drag" : kind === "wheel" ? c.kind === "wheel" : c.kind === "action"));

  // ── keyboard rows: command → inputs ──
  const q = query.trim().toLowerCase();
  const keyboardRows = table.filter(
    (c) =>
      c.kind === "action" &&
      !hidden?.has(c.id) &&
      (!q ||
        c.label.toLowerCase().includes(q) ||
        c.group.toLowerCase().includes(q) ||
        (eff.get(c.id) ?? []).some((s) => inputLabel(s, mac).toLowerCase().includes(q)))
  );
  const groups = [...new Set(keyboardRows.map((c) => c.group))];

  // ── import / export ──
  const doExport = async () => {
    const text = exportBindings(overrides, surface);
    const name = "flowrad-bindings.json";
    try {
      if (saveExport) await saveExport(text, name);
      else {
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setNotice({ text: "Bindings exported.", tone: "success" });
    } catch {
      setNotice({ text: "The bindings couldn't be exported.", tone: "warning" });
    }
  };
  const doImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parseBindings(await file.text(), table);
      onChange(parsed.overrides);
      setNotice({
        text: parsed.dropped.length
          ? `Imported. Left out (not available here): ${parsed.dropped.join(", ")}.`
          : "Bindings imported.",
        tone: parsed.dropped.length ? "warning" : "success",
      });
    } catch (err) {
      setNotice({ text: err instanceof BindingsFileError ? err.message : "That file couldn't be read.", tone: "warning" });
    }
  };

  const capturePad = (forCommand: BindingCommand | null) => (
    <div
      role="group"
      tabIndex={-1}
      aria-label="Capture area: press a key, click or drag with any mouse button, or tilt the wheel"
      data-binding-capture
      onPointerDown={(e) => {
        if (e.button === 0 && forCommand?.kind !== "drag") return;
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic or already-released pointer */
        }
        feedPad({ type: "pointerdown", button: e.button, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey });
      }}
      onPointerMove={(e) => feedPad({ type: "pointermove", clientX: e.clientX, clientY: e.clientY })}
      onPointerUp={(e) => {
        if (e.button === 0 && forCommand?.kind !== "drag") return;
        e.preventDefault();
        feedPad({ type: "pointerup", button: e.button, clientX: e.clientX, clientY: e.clientY });
      }}
      onAuxClick={(e) => {
        e.preventDefault();
        feedPad({ type: "auxclick", button: e.button, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey });
      }}
      onMouseUp={(e) => {
        // Buttons 4 / 5 would navigate back / forward.
        if (e.button >= 3) e.preventDefault();
      }}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) =>
        feedPad({
          type: "wheel",
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          wheelDeltaX: (e.nativeEvent as WheelEvent & { wheelDeltaX?: number }).wheelDeltaX,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
        })
      }
      className="mt-2 flex min-h-16 select-none items-center justify-center rounded-lg border border-dashed border-accent/60 bg-accent/5 px-3 py-3 text-center text-sm text-secondary"
    >
      {pending?.error ? (
        <span role="alert" className="text-warning">
          {pending.error}
        </span>
      ) : forCommand ? (
        <span>
          Press the key or button you want to bind
          <span className="block text-xs text-muted">Click or tilt here for mouse buttons · Esc cancels</span>
        </span>
      ) : (
        <span>
          Press, or press and drag, the mouse button you want to bind — here
          <span className="block text-xs text-muted">Any button your mouse has: back, forward, side and thumb buttons, tilt</span>
        </span>
      )}
    </div>
  );

  const confirmBar = (spec: string, conflict: BindingCommand | null | undefined, cmd: BindingCommand) => (
    <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-subtle bg-elevated px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 text-secondary">
        {conflict ? (
          <>
            <Kbd>{inputLabel(spec, mac)}</Kbd> is already {conflict.label} — swap or cancel?
          </>
        ) : (
          <>
            Received <Kbd>{inputLabel(spec, mac)}</Kbd> for {cmd.label}.
          </>
        )}
      </span>
      <Button size="sm" variant="primary" onClick={() => confirm(!!conflict)}>
        {conflict ? "Swap" : "Save"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
        Cancel
      </Button>
    </div>
  );

  // Mouse "add a button": capture an input, then pick its command.
  const [newMouse, setNewMouse] = useState<string | null>(null);
  useEffect(() => {
    if (pending?.commandId === null && pending.spec) {
      setNewMouse(pending.spec);
      setPending(null);
    }
  }, [pending]);

  return (
    <section className="flex flex-col gap-3" aria-label="Mouse and keyboard bindings" data-bindings-panel={surface}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          items={[
            { value: "mouse", label: "Mouse", icon: <Mouse className="h-4 w-4" aria-hidden="true" /> },
            { value: "keyboard", label: "Keyboard", icon: <Keyboard className="h-4 w-4" aria-hidden="true" /> },
          ]}
          value={tab}
          onValueChange={(v) => {
            setPending(null);
            setTab(v as Tab);
          }}
        />
        <span className="text-xs text-muted">Preset: RadiAnt standard{customised ? ` · ${customised} changed` : ""}</span>
      </div>

      {notice && (
        <p role="status" className={cn("rounded-md px-3 py-2 text-xs", notice.tone === "success" ? "bg-success/10 text-success" : "bg-warning/10 text-warning")}>
          {notice.text}
        </p>
      )}

      {tab === "mouse" ? (
        <div className="flex flex-col gap-1">
          <ul className="flex flex-col">
            {mouseRows.map((row) => {
              const holder = index.get(row.spec);
              const options = optionsFor(row.kind, holder);
              return (
                <li key={row.spec} className="flex items-center gap-3 py-1.5" data-binding-input={row.spec}>
                  <span className="min-w-0 flex-1 truncate text-sm text-primary">{inputLabel(row.spec, mac)}</span>
                  {row.fixed ? (
                    <span className="w-56 shrink-0 text-sm text-muted">{row.fixed}</span>
                  ) : (
                    <div className="w-56 shrink-0">
                      <Select
                        aria-label={`Command for ${inputLabel(row.spec, mac)}`}
                        value={holder ?? ""}
                        onChange={(e) => setMouseRow(row.spec, e.target.value)}
                        className="h-9"
                      >
                        <option value="">Nothing</option>
                        {options.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.kind === "action" ? `${c.group}: ${c.label}` : c.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                </li>
              );
            })}
            {newMouse && !mouseRows.some((r) => r.spec === newMouse) && (
              <li className="flex items-center gap-3 py-1.5" data-binding-input={newMouse}>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">{inputLabel(newMouse, mac)}</span>
                <div className="w-56 shrink-0">
                  <Select
                    aria-label={`Command for ${inputLabel(newMouse, mac)}`}
                    value=""
                    autoFocus
                    onChange={(e) => {
                      if (e.target.value) setMouseRow(newMouse, e.target.value);
                      setNewMouse(null);
                    }}
                    className="h-9"
                  >
                    <option value="">Choose a command…</option>
                    {optionsFor(inputKind(newMouse) === "drag" ? "drag" : "click").map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.kind === "action" ? `${c.group}: ${c.label}` : c.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </li>
            )}
          </ul>
          {pending?.commandId === null ? (
            <div>
              {capturePad(null)}
              <div className="mt-2 flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="pt-2">
              <Button size="sm" variant="secondary" leadingIcon={<Plus />} onClick={() => startCapture(null, "add")}>
                Add a mouse button…
              </Button>
              <p className="mt-1 text-xs text-muted">
                Works with any mouse — gaming and programmable mice included. Buttons your mouse software sends as keys (F13–F24, Ctrl+Alt+…) are bound on the
                Keyboard tab.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input
              type="search"
              placeholder="Search commands or keys"
              aria-label="Search commands or keys"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          {keyboardRows.length === 0 && <p className="py-6 text-center text-sm text-muted">No command matches “{query}”.</p>}
          {groups.map((group) => (
            <div key={group}>
              <h4 className="mb-1 mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{group}</h4>
              <ul className="flex flex-col">
                {keyboardRows
                  .filter((c) => c.group === group)
                  .map((c) => {
                    const inputs = eff.get(c.id) ?? [];
                    const listening = pending?.commandId === c.id;
                    const custom = isCustomised(overrides, c.id);
                    return (
                      <li key={c.id} className="py-1" data-binding-row={c.id}>
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm text-secondary">
                            {c.label}
                            {custom && <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-accent">changed</span>}
                          </span>
                          <span className="flex shrink-0 flex-wrap justify-end gap-1">
                            {inputs.length ? inputs.map((s) => <Kbd key={s}>{inputLabel(s, mac)}</Kbd>) : <span className="text-xs text-muted">Not bound</span>}
                          </span>
                          <Button
                            size="sm"
                            variant={listening ? "primary" : "secondary"}
                            aria-label={`Change the binding for ${c.label}`}
                            onClick={() => (listening ? setPending(null) : startCapture(c.id, "replace"))}
                          >
                            {listening ? "Cancel" : "Change"}
                          </Button>
                          <IconButton aria-label={`Add another input for ${c.label}`} size="sm" onClick={() => startCapture(c.id, "add")}>
                            <Plus />
                          </IconButton>
                          <IconButton
                            aria-label={`Restore the default for ${c.label}`}
                            size="sm"
                            disabled={!custom}
                            onClick={() => apply(resetCommand(table, overrides, c.id), `${c.label}: default restored`)}
                          >
                            <RotateCcw />
                          </IconButton>
                        </div>
                        {listening && (pending.spec ? confirmBar(pending.spec, pending.conflict, c) : capturePad(c))}
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))}
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t border-subtle pt-3">
        <Button size="sm" variant="ghost" disabled={!customised} onClick={() => apply({}, "All bindings restored to the RadiAnt preset.")}>
          Reset all
        </Button>
        <span className="flex-1 text-xs text-muted">{storedWhere ? `Saved ${storedWhere}.` : null}</span>
        <input
          id={fileId}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          data-bindings-import
          onChange={(e) => {
            void doImport(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <FilePickerButton inputId={fileId} variant="secondary" size="sm" leadingIcon={<Upload />}>
          Import
        </FilePickerButton>
        <Button size="sm" variant="secondary" leadingIcon={<Download />} onClick={() => void doExport()}>
          Export
        </Button>
      </footer>
    </section>
  );
}

export default BindingsPanel;
