// Small dialogs: keyboard sheet, custom window, disc picker, settings.

import { useEffect, useState } from "react";
import { Disc3, Usb } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { Slider } from "@/components/ui/Slider";
import {
  ACCELERATION_WINDOW_MS,
  createWheelScrollState,
  dragPixelsPerSlice,
  slicesForNotch,
  takeWheelSlices,
  type ScrollPreferences,
} from "@/lib/scrollSensitivity";
import { shortcutSheet } from "../shortcuts";
import type { ViewerSettings } from "../settings";
import { cacheUsage, clearCache, listMedia, type MediaVolume } from "../platform";

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows = shortcutSheet();
  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" description="Mouse: left = selected tool · wheel = scroll · Ctrl+wheel = zoom · right drag = window/level · middle drag = pan." size="xl">
      <div className="grid max-h-[60vh] grid-cols-1 gap-x-8 gap-y-5 overflow-y-auto pr-1 md:grid-cols-2">
        {groups.map((group) => (
          <section key={group}>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{group}</h3>
            <dl className="flex flex-col gap-1.5">
              {rows
                .filter((r) => r.group === group)
                .map((r) => (
                  <div key={r.keys + r.does} className="flex items-baseline justify-between gap-4 text-sm">
                    <dt className="text-secondary">{r.does}</dt>
                    <dd className="shrink-0">
                      <Kbd>{r.keys}</Kbd>
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

export function CustomWindowDialog({
  open,
  onClose,
  initial,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  initial: { ww?: number; wc?: number };
  onApply: (ww: number, wc: number) => void;
}) {
  const [ww, setWw] = useState("");
  const [wc, setWc] = useState("");
  useEffect(() => {
    if (open) {
      setWw(initial.ww != null ? String(Math.round(initial.ww)) : "400");
      setWc(initial.wc != null ? String(Math.round(initial.wc)) : "40");
    }
  }, [open, initial.ww, initial.wc]);
  const w = Number(ww);
  const c = Number(wc);
  const valid = Number.isFinite(w) && w >= 1 && Number.isFinite(c);
  const apply = () => {
    if (!valid) return;
    onApply(w, c);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set window"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={!valid}>
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
        <Field label="Width (WW)" error={!valid && ww !== "" ? "Width must be at least 1" : undefined}>
          {(field) => (
            <Input {...field} inputMode="decimal" value={ww} onChange={(e) => setWw(e.target.value)} autoFocus className="tabular-nums" />
          )}
        </Field>
        <Field label="Level (WL)">
          {(field) => (
            <Input {...field} inputMode="decimal" value={wc} onChange={(e) => setWc(e.target.value)} className="tabular-nums" />
          )}
        </Field>
        <button type="submit" className="sr-only">
          Apply
        </button>
      </form>
    </Modal>
  );
}

export function DiscPickerDialog({
  open,
  onClose,
  onPick,
  onBrowse,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
  onBrowse: () => void;
}) {
  const [media, setMedia] = useState<MediaVolume[] | null>(null);
  useEffect(() => {
    if (!open) return;
    setMedia(null);
    listMedia().then(setMedia, () => setMedia([]));
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open CD / DVD / USB"
      description="Drives with a DICOMDIR open through their index — the fastest way to read a disc."
      footer={
        <Button variant="secondary" onClick={onBrowse}>
          Browse for a folder…
        </Button>
      }
    >
      {media === null ? (
        <div className="flex items-center gap-2 py-6 text-sm text-secondary">
          <Spinner size="sm" label="Looking for drives" /> Looking for drives…
        </div>
      ) : media.length === 0 ? (
        <p className="py-4 text-sm text-secondary">
          No CD, DVD or USB drive found. Insert the disc and wait for your computer to mount it, or browse to the folder.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {media.map((v) => (
            <li key={v.path}>
              <button
                type="button"
                onClick={() => onPick(v.path)}
                className="flex w-full items-center gap-3 rounded-lg border border-subtle bg-surface px-3 py-2.5 text-left hover:border-strong hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {v.kind === "optical" ? <Disc3 className="h-5 w-5 text-secondary" aria-hidden /> : <Usb className="h-5 w-5 text-secondary" aria-hidden />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-primary">{v.label}</span>
                  <span className="block truncate text-xs text-muted">{v.path}</span>
                </span>
                {v.hasDicomdir && <span className="text-xs font-medium text-success">DICOMDIR</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-sm font-medium text-primary">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
    </label>
  );
}

/**
 * Live preview: wheel or drag over the strip and it moves through a pretend
 * 120-slice series with exactly the viewer's rules (same functions).
 */
function ScrollPreview({ prefs }: { prefs: ScrollPreferences }) {
  const COUNT = 120;
  const [index, setIndex] = useState(60);
  const [wheel] = useState(createWheelScrollState);
  const [run] = useState(() => ({ last: Number.NEGATIVE_INFINITY, length: 0 }));
  const [drag, setDrag] = useState<{ y: number; acc: number } | null>(null);
  const move = (delta: number) => setIndex((i) => Math.max(0, Math.min(COUNT - 1, i + delta)));
  // Automatic drag in the viewer depends on viewport height / slice count; show a typical value.
  const dragPx = dragPixelsPerSlice(Math.max(2, 600 / COUNT), prefs);
  return (
    <div className="mt-1">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Scroll preview: wheel or drag here"
        aria-valuemin={1}
        aria-valuemax={COUNT}
        aria-valuenow={index + 1}
        onWheel={(e) => {
          const now = performance.now();
          const steps = takeWheelSlices(wheel, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY, now);
          if (!steps) return;
          if (now - run.last < ACCELERATION_WINDOW_MS) run.length += 1;
          else run.length = 1;
          run.last = now;
          move(Math.sign(steps) * Math.abs(steps) * slicesForNotch(prefs, run.length));
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag({ y: e.clientY, acc: 0 });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const acc = drag.acc + (e.clientY - drag.y);
          const steps = Math.trunc(acc / dragPx);
          if (steps) move(steps);
          setDrag({ y: e.clientY, acc: acc - steps * dragPx });
        }}
        onPointerUp={() => setDrag(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowRight") move(1);
          if (e.key === "ArrowUp" || e.key === "ArrowLeft") move(-1);
        }}
        className="relative flex h-14 cursor-ns-resize select-none items-center justify-between overflow-hidden rounded-lg border border-subtle bg-black px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="text-xs text-secondary">Try it: wheel or drag here</span>
        <span className="text-sm font-medium text-primary tabular-nums">
          Im {index + 1} / {COUNT}
        </span>
        <span aria-hidden className="absolute bottom-0 left-0 h-0.5 bg-accent" style={{ width: `${((index + 1) / COUNT) * 100}%` }} />
      </div>
    </div>
  );
}

export function SettingsDialog({
  open,
  onClose,
  settings,
  onChange,
  version,
  extra,
}: {
  open: boolean;
  onClose: () => void;
  settings: ViewerSettings;
  onChange: (patch: Partial<ViewerSettings>) => void;
  version: string;
  /** Account / update sections contributed by later stages. */
  extra?: React.ReactNode;
}) {
  const [usage, setUsage] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    if (open) cacheUsage().then(setUsage, () => setUsage(null));
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Settings" size="lg">
      <div className="flex max-h-[65vh] flex-col divide-y divide-subtle overflow-y-auto pr-1">
        <section className="pb-3">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Display</h3>
          <Toggle label="Show DICOM overlay" description="Patient, study and image details in the viewport corners." checked={settings.showOverlay} onChange={(v) => onChange({ showOverlay: v })} />
          <Toggle label="Scale bar" description="A calibrated ruler on images with pixel spacing." checked={settings.scaleBar} onChange={(v) => onChange({ scaleBar: v })} />
          <Toggle
            label="Hide patient name and ID"
            description="For teaching and screen sharing: the overlay and series list show no name, ID or birth date."
            checked={settings.hidePatient}
            onChange={(v) => onChange({ hidePatient: v })}
          />
          <Toggle label="Compact series list" description="One line per series instead of thumbnails." checked={settings.compactSeries} onChange={(v) => onChange({ compactSeries: v })} />
        </section>
        <section className="py-3">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Scrolling</h3>
          <Slider
            label="Mouse wheel"
            min={1}
            max={10}
            value={settings.scrollSlicesPerNotch}
            valueLabel={`${settings.scrollSlicesPerNotch} slice${settings.scrollSlicesPerNotch === 1 ? "" : "s"} per notch`}
            onChange={(v) => onChange({ scrollSlicesPerNotch: v })}
          />
          <Slider
            label="Browse drag (B)"
            min={0}
            max={40}
            value={settings.scrollDragPx}
            valueLabel={settings.scrollDragPx === 0 ? "Automatic" : `${settings.scrollDragPx} px per slice`}
            description="Pixels of drag per slice. Lower is faster. Automatic scales to the series length."
            onChange={(v) => onChange({ scrollDragPx: v })}
          />
          <Toggle
            label="Acceleration"
            description="A quick run of wheel notches moves progressively further (up to 4×)."
            checked={settings.scrollAcceleration}
            onChange={(v) => onChange({ scrollAcceleration: v })}
          />
          <ScrollPreview
            prefs={{
              slicesPerNotch: settings.scrollSlicesPerNotch,
              dragPixelsPerSlice: settings.scrollDragPx > 0 ? settings.scrollDragPx : null,
              acceleration: settings.scrollAcceleration,
            }}
          />
        </section>
        <section className="py-3">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Privacy &amp; storage</h3>
          <Toggle
            label="Remember recently opened studies"
            description="Keeps folder paths, study descriptions and counts. Never patient names or images."
            checked={settings.rememberHistory}
            onChange={(v) => onChange({ rememberHistory: v })}
          />
          <div className="flex items-center justify-between gap-4 py-2">
            <span>
              <span className="block text-sm font-medium text-primary">Scan &amp; archive cache</span>
              <span className="block text-xs text-muted tabular-nums">
                {usage == null ? "…" : `${(usage / 1024 / 1024).toFixed(1)} MB`} — makes re-opening a study instant. Holds no patient names.
              </span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              loading={clearing}
              onClick={async () => {
                setClearing(true);
                try {
                  await clearCache();
                  setUsage(await cacheUsage());
                } finally {
                  setClearing(false);
                }
              }}
            >
              Clear
            </Button>
          </div>
        </section>
        {extra}
        <section className="pt-3 text-xs text-muted">
          <p>
            FlowRad Viewer <span className="tabular-nums">{version}</span>. Works fully offline: opening, viewing and
            exporting never touch the network.
          </p>
          <p className="mt-1 font-medium text-warning">Not for diagnostic use.</p>
        </section>
      </div>
    </Modal>
  );
}
