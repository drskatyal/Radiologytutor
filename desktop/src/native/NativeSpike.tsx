// Phase 2, P2.0 spike (docs/NATIVE_RENDERER.md): the viewport is drawn by
// Rust (wgpu) UNDER this page; the page is transparent over the cell and draws
// only chrome and an SVG overlay on top. Opened with FLOWRAD_NATIVE=1 and
// FLOWRAD_BENCH_VIEW=native-spike.
//
// Drag in the viewport: horizontal = window width, vertical = level. Each
// change is one IPC call that re-renders natively; its round trip is shown
// and, in a bench run, reported (p50 / p95 / max).

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { benchEnabled, benchReport, invoke } from "../platform";
import { longTasks } from "../perfWatch";

interface NativeStatus {
  enabled: boolean;
  ready: boolean;
  adapter?: string | null;
  backend?: string | null;
  error?: string | null;
  initMs?: number | null;
  lastFrameMs?: number | null;
  frames: number;
  clientOrigin?: [number, number] | null;
  scale?: number | null;
}

// The test image's full range (i16 0..32767); a study uses its own window.
const FULL: [number, number] = [16384, 32767];

interface ShowResult {
  index: number;
  count: number;
  cached: boolean;
  decodeMs: number;
  frameMs: number;
  totalMs: number;
  rows: number;
  cols: number;
  window: [number, number];
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
};

export default function NativeSpike() {
  const cellRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<NativeStatus | null>(null);
  const [wl, setWl] = useState<[number, number]>(FULL);
  const [lastRtt, setLastRtt] = useState<number | null>(null);
  // P2.1: a study from the command line, shown natively.
  const [shown, setShown] = useState<ShowResult | null>(null);
  const [studyError, setStudyError] = useState<string | null>(null);
  const rtts = useRef<number[]>([]);
  const pending = useRef<[number, number] | null>(null);
  const inflight = useRef(false);

  // Transparent page where the native surface shows through (only here).
  useEffect(() => {
    document.documentElement.classList.add("native-transparent");
    return () => document.documentElement.classList.remove("native-transparent");
  }, []);

  const rect = useCallback(() => {
    const r = cellRef.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  }, []);

  // One W/L call in flight at a time; drags coalesce to the latest value.
  const pump = useCallback(async () => {
    if (inflight.current || !pending.current) return;
    const [center, width] = pending.current;
    pending.current = null;
    inflight.current = true;
    const t = performance.now();
    try {
      await invoke<number>("native_set_wl", { center, width });
      const rtt = performance.now() - t;
      rtts.current.push(rtt);
      setLastRtt(rtt);
    } finally {
      inflight.current = false;
      if (pending.current) void pump();
    }
  }, []);

  const applyWl = useCallback(
    (next: [number, number]) => {
      setWl(next);
      pending.current = next;
      void pump();
    },
    [pump]
  );

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;
    (async () => {
      const s = await invoke<NativeStatus>("native_init").catch((e: unknown) => ({ enabled: true, ready: false, frames: 0, error: String(e) }));
      if (disposed) return;
      setStatus(s);
      if (!s.ready) return;
      const send = () => {
        const r = rect();
        if (r) void invoke("native_set_cells", { cells: [r] }).then(() => invoke<NativeStatus>("native_status").then(setStatus));
      };
      observer = new ResizeObserver(send);
      if (cellRef.current) observer.observe(cellRef.current);
      await new Promise<void>((resolve) => {
        const r = rect();
        if (!r) return resolve();
        void invoke("native_set_cells", { cells: [r] }).then(() => resolve(), () => resolve());
      });

      // P2.1: a study on the command line opens natively (largest series).
      type Opened = { listMs: number; firstImageMs: number; firstImageSinceStartMs: number; first: ShowResult };
      const opened = await invoke<Opened>("native_open_launch_study").catch((e: unknown) => {
        const msg = String(e);
        if (!/no study on the command line/.test(msg)) setStudyError(msg);
        return null;
      });
      if (disposed) return;
      if (opened) {
        setShown(opened.first);
        setWl(opened.first.window);
      }

      if (!(await benchEnabled())) return;
      if (opened) {
        // Scroll 120 slices one per call (like the 2D frame bench), then report.
        const steps: ShowResult[] = [];
        const rtt: number[] = [];
        for (let i = 0; i < 120; i += 1) {
          const t = performance.now();
          steps.push(await invoke<ShowResult>("native_scroll", { delta: 1 }));
          rtt.push(performance.now() - t);
        }
        await new Promise((r) => setTimeout(r, 1500));
        const stats = await invoke<unknown>("native_store_stats");
        await benchReport({
          view: "native-spike",
          native: await invoke<NativeStatus>("native_status"),
          study: {
            images: opened.first.count,
            listMs: opened.listMs,
            firstImageMs: opened.firstImageMs,
            firstImageSinceStartMs: opened.firstImageSinceStartMs,
            firstDecodeMs: opened.first.decodeMs,
            firstFrameMs: opened.first.frameMs,
            size: [opened.first.cols, opened.first.rows],
          },
          scroll: {
            steps: steps.length,
            cachedShare: steps.filter((s) => s.cached).length / Math.max(1, steps.length),
            p50Ms: pct(rtt, 50),
            p95Ms: pct(rtt, 95),
            maxMs: pct(rtt, 100),
            decodeMaxMs: Math.max(...steps.map((s) => s.decodeMs)),
          },
          store: stats,
          longTasks: { count: longTasks.count, maxMs: longTasks.maxMs, recent: longTasks.recent },
        });
        return;
      }
      // Bench: a W/L sweep through IPC, then back to the full window, then report.
      await new Promise((r) => setTimeout(r, 500));
      for (let i = 0; i < 60; i += 1) {
        const t = performance.now();
        await invoke<number>("native_set_wl", { center: 10000 + i * 200, width: 4000 + i * 250 });
        rtts.current.push(performance.now() - t);
      }
      await invoke<number>("native_set_wl", { center: FULL[0], width: FULL[1] });
      await new Promise((r) => setTimeout(r, 800));
      const final = await invoke<NativeStatus>("native_status");
      const r = rect();
      const scale = final.scale ?? window.devicePixelRatio;
      const [ox, oy] = final.clientOrigin ?? [0, 0];
      await benchReport({
        view: "native-spike",
        native: final,
        ipc: { calls: rtts.current.length, p50Ms: pct(rtts.current, 50), p95Ms: pct(rtts.current, 95), maxMs: pct(rtts.current, 100) },
        // Physical screen rect of the cell, for the compositing e2e's screen grab.
        cellScreen: r && { x: Math.round(ox + r.x * scale), y: Math.round(oy + r.y * scale), w: Math.round(r.w * scale), h: Math.round(r.h * scale) },
        longTasks: { count: longTasks.count, maxMs: longTasks.maxMs, recent: longTasks.recent },
      });
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [rect]);

  // Drag: x → width, y → level.
  const drag = useRef<{ x: number; y: number; wl: [number, number] } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, wl };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const k = Math.max(1, d.wl[1] / 250);
    const width = Math.max(1, d.wl[1] + (e.clientX - d.x) * k);
    const center = d.wl[0] - (e.clientY - d.y) * k;
    applyWl([center, width]);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const p95 = pct(rtts.current, 95);
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-subtle bg-surface px-4 py-2">
        <h1 className="text-sm font-semibold text-primary">Native renderer spike</h1>
        <Badge variant="accent">P2.0</Badge>
        {status == null && <Spinner size="sm" label="Starting the GPU surface" />}
        {status && !status.ready && (
          <span role="alert" className="text-xs text-danger">
            {status.enabled ? `Native renderer unavailable: ${status.error ?? "unknown error"}` : "Set FLOWRAD_NATIVE=1 to enable the native renderer."}
          </span>
        )}
        {status?.ready && (
          <span className="text-xs tabular-nums text-secondary">
            {status.adapter} · {status.backend} · init {Math.round(status.initMs ?? 0)} ms · frame {status.lastFrameMs?.toFixed(2) ?? "–"} ms
          </span>
        )}
        {shown && (
          <span className="text-xs tabular-nums text-secondary">
            Im {shown.index + 1} / {shown.count} · {shown.cols}×{shown.rows} · {shown.cached ? "cached" : `decoded ${shown.decodeMs.toFixed(1)} ms`} · {shown.totalMs.toFixed(1)} ms
          </span>
        )}
        {studyError && (
          <span role="alert" className="text-xs text-danger">
            Study could not be opened natively: {studyError}
          </span>
        )}
        <span className="ml-auto text-xs tabular-nums text-muted">
          W {Math.round(wl[1])} · L {Math.round(wl[0])}
          {lastRtt != null && ` · IPC+render ${lastRtt.toFixed(1)} ms (p95 ${p95 ?? "–"})`}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <aside className="w-56 shrink-0 rounded-lg border border-subtle bg-surface p-3 text-xs text-secondary">
          The viewport on the right is drawn by Rust with the GPU, under this page. The page is transparent there and draws only the overlay on top.
          <br />
          <br />
          Drag in the viewport to change window (←→) and level (↑↓). With a study on the command line, the wheel scrolls its slices.
        </aside>
        <div
          ref={cellRef}
          data-native-cell
          role="img"
          aria-label="Native viewport (test image)"
          className="relative min-w-0 flex-1 cursor-crosshair touch-none rounded-lg border border-strong"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={(e) => {
            if (!shown) return;
            void invoke<ShowResult>("native_scroll", { delta: Math.sign(e.deltaY) }).then(setShown, () => undefined);
          }}
        >
          {/* WebView overlay ON TOP of the native pixels: crosshair + label. */}
          <svg className="pointer-events-none absolute inset-0 h-full w-full text-warning" aria-hidden>
            <line x1="50%" y1="0" x2="50%" y2="100%" stroke="currentColor" strokeWidth="3" />
            <line x1="0" y1="50%" x2="100%" y2="50%" stroke="currentColor" strokeWidth="3" />
          </svg>
          <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/70 px-2 py-1 text-xs font-medium text-white">
            WebView overlay
          </span>
        </div>
      </div>
    </div>
  );
}
